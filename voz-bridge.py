#!/usr/bin/env python3
"""
Bridge de contexto — ElevenLabs Agent <-> OpenClaw (Jesus).

Faz o agente de voz atender COMO o Jesus, com o contexto daquele contato:
  POST /elevenlabs/init      conversation initiation webhook → injeta persona + histórico
  POST /elevenlabs/jesus     server tool (híbrido 🅐) → roda 1 turno do Jesus ao vivo
  POST /elevenlabs/enviar    server tool → durante a ligação, Jesus gera algo e ENVIA no WhatsApp
  POST /elevenlabs/postcall  post-call webhook → grava transcrição + Jesus continua por WhatsApp

Roda no MESMO host do OpenClaw (usa o binário `openclaw` e lê o workspace).
Sem dependências externas (stdlib). Config via .env ao lado deste arquivo.

Teste local sem ElevenLabs:
  python3 bridge.py selftest +55119XXXXXXXX
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")

# --- limites de contexto (frases curtas funcionam melhor em voz) ---
MAX_HISTORY_CHARS = 4000
MAX_MEMORY_HITS = 5
SIG_TOLERANCE_SEC = 30 * 60  # ElevenLabs: 30 min
MAX_BODY = 2 * 1024 * 1024   # 2 MB — corta DoS por Content-Length gigante
MEMORY_TIMEOUT_SEC = 4       # /init tem que ser rápido (webhook ~5s)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


# ---------------- config ----------------
def carregar_env():
    cfg = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, encoding="utf-8") as f:
            for linha in f:
                linha = linha.strip()
                if not linha or linha.startswith("#") or "=" not in linha:
                    continue
                k, _, v = linha.partition("=")
                cfg[k.strip()] = v.strip()
    # env do processo tem prioridade (pm2/systemd)
    for k in list(cfg):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    return cfg


CFG = carregar_env()


def conf(chave, default=""):
    return os.environ.get(chave) or CFG.get(chave) or default


# Onde o OpenClaw vive (no VPS troque via .env)
OPENCLAW_BIN = conf("OPENCLAW_BIN", "openclaw")
OPENCLAW_HOME = os.path.expanduser(conf("OPENCLAW_HOME", "~/.openclaw"))
OPENCLAW_WORKSPACE = os.path.expanduser(conf("OPENCLAW_WORKSPACE", "~/.openclaw/workspace"))
OPENCLAW_AGENT_ID = conf("OPENCLAW_AGENT_ID", "main")   # no VPS provavelmente "jesus"
OPENCLAW_CHANNEL = conf("OPENCLAW_CHANNEL", "whatsapp")

# uazapi: a voz agora envia WhatsApp pela mesma via nova do Jesus (não mais Baileys)
UAZAPI_URL = conf("UAZAPI_URL", "https://YOUR_SUBDOMAIN.uazapi.com").rstrip("/")
UAZAPI_TOKEN = conf("UAZAPI_TOKEN")

INIT_SECRET = conf("EL_INIT_WEBHOOK_SECRET")
POSTCALL_SECRET = conf("EL_POSTCALL_WEBHOOK_SECRET")
TOOL_BEARER = conf("BRIDGE_TOOL_BEARER")
VERIFY_SIGS = conf("EL_VERIFY_SIGNATURES", "1") not in ("0", "false", "False", "")
# Lockdown: /init exige header secreto; /postcall só age se houve /init real recente.
INIT_HEADER_SECRET = conf("BRIDGE_INIT_SECRET")
RECENT_TTL = 3600  # segundos que um /postcall é aceito após o /init daquele caller
_recent_callers = {}
_recent_lock = threading.Lock()


def log(*a):
    print("[bridge]", *a, file=sys.stderr, flush=True)


# ---------------- OpenClaw access layer ----------------
def _run(args, timeout):
    """Roda o openclaw CLI; devolve (ok, stdout, stderr)."""
    try:
        p = subprocess.run(
            [OPENCLAW_BIN, *args],
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "HOME": os.environ.get("HOME") or os.path.expanduser("~")},
        )
        return p.returncode == 0, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    except FileNotFoundError:
        return False, "", f"binário não encontrado: {OPENCLAW_BIN}"


def ler_persona():
    """Persona do Jesus: SOUL.md + IDENTITY.md + regras-chave do AGENTS.md."""
    partes = []
    for nome in ("IDENTITY.md", "SOUL.md", "AGENTS.md"):
        caminho = os.path.join(OPENCLAW_WORKSPACE, nome)
        try:
            with open(caminho, encoding="utf-8") as f:
                partes.append(f"# {nome}\n{f.read().strip()}")
        except OSError:
            pass
    return "\n\n".join(partes)


def _normalizar(caller):
    return "".join(ch for ch in (caller or "") if ch.isdigit())


def _marcar_caller(caller):
    """Registra que houve uma ligação real (chamado no /init)."""
    d = _normalizar(caller)
    if d:
        with _recent_lock:
            _recent_callers[d] = datetime.datetime.now().timestamp()


def _caller_recente(caller):
    """True se esse número teve um /init dentro da janela (anti-abuso do /postcall)."""
    d = _normalizar(caller)
    if not d:
        return False
    with _recent_lock:
        ts = _recent_callers.get(d)
    return ts is not None and (datetime.datetime.now().timestamp() - ts) < RECENT_TTL


def ler_historico(caller):
    """Últimos turnos da conversa daquele contato (best-effort via sessions.json)."""
    digits = _normalizar(caller)
    if not digits:
        return ""
    sess_dir = os.path.join(OPENCLAW_HOME, "agents", OPENCLAW_AGENT_ID, "sessions")
    index = os.path.join(sess_dir, "sessions.json")
    candidatos = []  # (recencia, uuid)
    try:
        with open(index, encoding="utf-8") as f:
            dados = json.load(f)
        entradas = list(dados.values()) if isinstance(dados, dict) else dados
        for e in entradas:
            if not isinstance(e, dict):
                continue
            # número do contato em campos conhecidos, comparado de forma EXATA
            alvo = ""
            for campo in ("peer", "peerId", "to", "phone", "contact", "key", "sessionKey", "id"):
                v = e.get(campo)
                if isinstance(v, dict):
                    v = v.get("id") or v.get("number") or ""
                if v and digits == _normalizar(str(v)):
                    alvo = str(v)
                    break
            if not alvo:
                continue
            if OPENCLAW_CHANNEL and OPENCLAW_CHANNEL not in json.dumps(e):
                continue
            uid = e.get("id") or e.get("sessionId") or e.get("uuid")
            recencia = e.get("updatedAt") or e.get("createdAt") or e.get("lastMessageAt") or ""
            if uid and UUID_RE.match(str(uid)):
                candidatos.append((str(recencia), str(uid)))
    except (OSError, ValueError, AttributeError):
        return ""
    if not candidatos:
        return ""
    candidatos.sort(reverse=True)  # mais recente primeiro
    uuid = candidatos[0][1]
    jsonl = os.path.join(sess_dir, f"{uuid}.jsonl")
    turnos = []
    try:
        with open(jsonl, encoding="utf-8") as f:
            for linha in f:
                try:
                    ev = json.loads(linha)
                except ValueError:
                    continue
                papel = ev.get("role") or ev.get("type")
                texto = ev.get("content") or ev.get("text") or ev.get("message")
                if isinstance(texto, list):
                    texto = " ".join(str(x.get("text", "")) for x in texto if isinstance(x, dict))
                if papel in ("user", "assistant") and texto:
                    turnos.append(f"{papel}: {str(texto).strip()}")
    except OSError:
        return ""
    historico = "\n".join(turnos[-30:])
    return historico[-MAX_HISTORY_CHARS:]


def buscar_memoria(caller):
    """Fatos relevantes da memória vetorial do Jesus sobre esse contato."""
    digits = _normalizar(caller)
    ok, out, _ = _run(["memory", "search", digits or caller, "--json"], timeout=MEMORY_TIMEOUT_SEC)
    if not ok or not out:
        return ""
    try:
        dados = json.loads(out)
        hits = dados if isinstance(dados, list) else dados.get("results", [])
        linhas = []
        for h in hits[:MAX_MEMORY_HITS]:
            t = h.get("text") or h.get("snippet") or h.get("content") if isinstance(h, dict) else str(h)
            if t:
                linhas.append(f"- {t.strip()}")
        return "\n".join(linhas)
    except ValueError:
        return out[:1500]


def _digits(s):
    return re.sub(r"\D", "", str(s or ""))


def _session_key(caller):
    """Sessão isolada por contato (mesma convenção da empresa-ia-bridge do WhatsApp)."""
    d = _digits(caller)
    return f"agent:main:wa:{d or caller}"


def _extrair_texto(out):
    """Extrai o texto visível da resposta do `openclaw agent --json` (formato 2026.x)."""
    try:
        d = json.loads(out)
    except ValueError:
        return (out or "").strip()
    res = d.get("result") or {}
    meta = res.get("meta") or {}
    payloads = res.get("payloads") or []
    txt = "\n\n".join(
        p.get("text") for p in payloads if isinstance(p, dict) and p.get("text")
    )
    return (txt or meta.get("finalAssistantVisibleText")
            or meta.get("finalAssistantRawText") or "").strip()


def enviar_uazapi(numero, texto):
    """Envia texto no WhatsApp via uazapi (substitui o antigo --deliver/Baileys)."""
    numero = _digits(numero)
    if not (UAZAPI_TOKEN and numero and texto):
        log("enviar_uazapi abortado: faltam token/numero/texto")
        return False
    body = json.dumps({"number": numero, "text": texto}).encode("utf-8")
    req = urllib.request.Request(
        f"{UAZAPI_URL}/send/text", data=body,
        headers={"token": UAZAPI_TOKEN, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        return True
    except Exception as e:  # noqa: BLE001 — log e segue
        log("enviar_uazapi falhou:", e)
        return False


_session_locks = {}
_session_locks_guard = threading.Lock()


def _lock_for(caller):
    """Um lock por sessão — serializa turnos do mesmo contato (evita o deadlock do claude-cli
    em chamadas concorrentes e faz a consulta real aproveitar o cache do pré-aquecimento)."""
    k = _session_key(caller)
    with _session_locks_guard:
        lock = _session_locks.get(k)
        if lock is None:
            lock = _session_locks[k] = threading.Lock()
    return lock


def _rodar_jesus(caller, mensagem, timeout=150):
    """Roda 1 turno do Jesus na sessão isolada do contato; devolve (ok, texto, err)."""
    with _lock_for(caller):
        ok, out, err = _run(
            ["agent", "--agent", "main", "--message", mensagem,
             "--session-key", _session_key(caller), "--json",
             "--timeout", str(max(15, timeout - 20))],
            timeout=timeout,
        )
    if not ok:
        return False, "", err
    return True, _extrair_texto(out), ""


def _preaquecer_sessao(caller):
    """No início da ligação, esquenta o cache da sessão p/ cortar o cold-start (~17s → ~6s)."""
    if not _digits(caller):
        return

    def _warm():
        ok, _, err = _rodar_jesus(
            caller,
            "(Sistema: aquecendo a sessão de voz. Não diga nada relevante; responda apenas: pronto.)",
            timeout=40,
        )
        log("pré-aquecimento", "ok" if ok else f"falhou {err}", "para", caller)

    threading.Thread(target=_warm, daemon=True).start()


def jesus_turn(caller, mensagem):
    """Híbrido 🅐: roda 1 turno real do Jesus na sessão daquele contato (texto p/ a voz falar)."""
    if not caller or not mensagem:
        return "Desculpa, não entendi. Pode repetir?"
    ok, texto, err = _rodar_jesus(caller, mensagem, timeout=30)
    if not ok:
        log("jesus_turn falhou:", err)
        return "Deixa eu verificar isso e já te retorno, tá?"
    return texto or "Certo."


def jesus_deliver(caller, pedido):
    """Durante a ligação: o Jesus gera o que o cliente pediu e ENVIA no WhatsApp dele (via uazapi)."""
    instrucao = (
        "Durante uma ligação de voz, o cliente PEDIU para você ENVIAR algo no WhatsApp dele agora. "
        "Gere o conteúdo solicitado (relatório, resumo, lista, link, etc.) e responda com a "
        "mensagem COMPLETA que será enviada no WhatsApp dele. Seja útil, no seu personagem. "
        f"Pedido do cliente: {pedido}"
    )
    ok, texto, err = _rodar_jesus(caller, instrucao, timeout=150)
    enviado = ok and texto and enviar_uazapi(caller, texto)
    log("envio WhatsApp (uazapi) para", caller, ":", "ok" if enviado else f"falhou {err or 'sem texto'}")


def persist_postcall(data):
    """Grava a transcrição da ligação no log diário do Jesus (vira contexto futuro)."""
    meta = data.get("metadata", {}) or {}
    def _limpar(s, n=2000):
        return str(s).replace("\r", " ").replace("\n", " ").lstrip("#").strip()[:n]

    caller = (data.get("conversation_initiation_client_data", {})
              .get("dynamic_variables", {}).get("system__caller_id")) or meta.get("caller_id") or "desconhecido"
    caller = _limpar(caller, 64)
    # Anti-abuso: só age se esse número teve uma ligação real (passou pelo /init) há pouco.
    if not _caller_recente(caller):
        log("postcall ignorado (sem /init recente p/ esse número):", caller)
        return
    transcript = data.get("transcript", []) or []
    linhas = []
    for t in transcript:
        papel = _limpar(t.get("role", "?"), 16)
        msg = t.get("message") or t.get("text") or ""
        if msg:
            linhas.append(f"  {papel}: {_limpar(msg)}")
    if not linhas:
        return
    agora = datetime.datetime.now()
    bloco = (f"\n## [Ligação de voz] {agora:%H:%M} — {caller}\n"
             + "\n".join(linhas) + "\n")
    memdir = os.path.join(OPENCLAW_WORKSPACE, "memory")
    os.makedirs(memdir, exist_ok=True)
    arq = os.path.join(memdir, f"{agora:%Y-%m-%d}.md")
    try:
        with open(arq, "a", encoding="utf-8") as f:
            f.write(bloco)
        log("postcall gravado em", arq)
    except OSError as e:
        log("falha ao gravar postcall:", e)

    # Continuar a conversa por WhatsApp: o Jesus manda um follow-up pro contato.
    # Em thread separada — o /postcall responde 200 na hora e o turno do Jesus roda atrás.
    if _normalizar(caller):
        transcript_txt = "\n".join(linhas)[:3000]
        threading.Thread(
            target=enviar_followup_whatsapp,
            args=(caller, transcript_txt),
            daemon=True,
        ).start()


def enviar_followup_whatsapp(caller, transcript_txt):
    """No fim da ligação, o Jesus envia UM WhatsApp continuando a conversa."""
    instrucao = (
        "A ligação de voz com este contato acabou agora. Abaixo a transcrição. "
        "Envie UMA mensagem de WhatsApp curta, natural e no seu personagem, "
        "continuando a conversa de onde parou (não repita tudo, não soe robótico; "
        "se ficou algo pendente, dê o próximo passo). "
        f"Transcrição da ligação:\n{transcript_txt}"
    )
    ok, texto, err = _rodar_jesus(caller, instrucao, timeout=150)
    enviado = ok and texto and enviar_uazapi(caller, texto)
    if enviado:
        log("follow-up WhatsApp (uazapi) enviado para", caller)
    else:
        log("follow-up WhatsApp falhou:", err or "sem texto")


# ---------------- montagem da resposta /init ----------------
def build_init_response(caller):
    persona = ler_persona()
    historico = ler_historico(caller)
    memoria = buscar_memoria(caller)

    contexto = ""
    if historico:
        contexto += f"\n\n# Conversa recente com esta pessoa (WhatsApp)\n{historico}"
    if memoria:
        contexto += f"\n\n# O que você sabe sobre esta pessoa\n{memoria}"
    if not contexto:
        contexto = "\n\n# Contexto\nPrimeiro contato por voz — você ainda não tem histórico desta pessoa."

    prompt = (
        f"{persona}\n"
        f"{contexto}\n\n"
        "# Você está ATENDENDO UMA LIGAÇÃO DE VOZ agora\n"
        "- Você é o Jesus, o mesmo do WhatsApp. Continue a relação, não se reapresente do zero.\n"
        "- Fale pt-BR, frases curtas e naturais (é voz, não texto). Uma ideia por vez.\n"
        "- Use o contexto acima para já saber quem é e o que rolou.\n"
        "- Se o cliente pedir para RECEBER algo no WhatsApp (relatório, resumo, link, lista), "
        "use a ferramenta enviar_no_whatsapp e avise que já está mandando no zap dele.\n"
        "- Não invente. Se não souber, diga que vai verificar."
    )

    primeira = "Oi! Aqui é o Jesus. Como posso ajudar?"
    if historico or memoria:
        primeira = "Oi! Aqui é o Jesus de novo. Em que posso ajudar hoje?"

    return {
        "type": "conversation_initiation_client_data",
        "dynamic_variables": {"caller_id": caller or ""},
        "conversation_config_override": {
            "agent": {
                "prompt": {"prompt": prompt},
                "first_message": primeira,
                "language": "pt",
            }
        },
    }


# ---------------- HMAC ----------------
def verify_sig(raw, header, secret):
    if not VERIFY_SIGS:
        return True
    if not secret or not header:
        return False
    try:
        partes = dict(p.split("=", 1) for p in header.split(","))
        ts, v0 = partes.get("t", ""), partes.get("v0", "")
    except ValueError:
        return False
    if not ts or not v0:
        return False
    try:
        if abs(int(datetime.datetime.now().timestamp()) - int(ts)) > SIG_TOLERANCE_SEC:
            return False
    except ValueError:
        return False
    payload = f"{ts}.{raw.decode('utf-8', 'replace')}".encode("utf-8")
    esperado = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, v0)


# ---------------- HTTP ----------------
class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        cl = int(self.headers.get("Content-Length", 0) or 0)
        if cl > MAX_BODY:
            return self._send(413, {"error": "payload too large"})
        raw = self.rfile.read(cl)
        path = self.path.rstrip("/")

        def parse():
            try:
                return json.loads(raw or b"{}"), None
            except (ValueError, UnicodeDecodeError):
                return None, self._send(400, {"error": "invalid json"})

        if path == "/elevenlabs/init":
            if INIT_HEADER_SECRET and not hmac.compare_digest(
                    self.headers.get("X-Bridge-Auth", "").encode(), INIT_HEADER_SECRET.encode()):
                return self._send(401, {"error": "unauthorized"})
            body, _ = parse()
            if body is None:
                return
            caller = body.get("caller_id", "")   # NUNCA call_sid (vazio no SIP)
            if caller:
                _marcar_caller(caller)  # libera o /postcall desse número
                _preaquecer_sessao(caller)  # esquenta o cache p/ a 1ª resposta sair rápida
            else:
                log("⚠️ init sem caller_id — Jesus atende com persona, mas SEM histórico "
                    "(verifique X-Caller-ID no painel SIP do Wavoip)")
            # SEMPRE injeta a persona do Jesus + (se houver número) o histórico do contato.
            return self._send(200, build_init_response(caller))

        if path == "/elevenlabs/jesus":
            esperado = f"Bearer {TOOL_BEARER}"
            recebido = self.headers.get("Authorization", "")
            if not TOOL_BEARER or not hmac.compare_digest(recebido.encode(), esperado.encode()):
                return self._send(401, {"error": "unauthorized"})
            body, _ = parse()
            if body is None:
                return
            reply = jesus_turn(body.get("caller_id", ""), body.get("user_message", ""))
            return self._send(200, {"reply": reply})

        if path == "/elevenlabs/enviar":
            esperado = f"Bearer {TOOL_BEARER}"
            recebido = self.headers.get("Authorization", "")
            if not TOOL_BEARER or not hmac.compare_digest(recebido.encode(), esperado.encode()):
                return self._send(401, {"error": "unauthorized"})
            body, _ = parse()
            if body is None:
                return
            caller = body.get("caller_id", "")
            pedido = body.get("pedido", "")
            if _normalizar(caller) and pedido:
                # gera + envia em background; responde na hora pra não travar a ligação
                threading.Thread(target=jesus_deliver, args=(caller, pedido), daemon=True).start()
                return self._send(200, {"status": "enviando",
                                        "message": "Pronto! Já tô preparando e te envio no WhatsApp em instantes."})
            return self._send(200, {"status": "erro",
                                    "message": "Não consegui identificar seu número para enviar."})

        if path == "/elevenlabs/postcall":
            body, _ = parse()
            if body is None:
                return
            if body.get("type") == "post_call_transcription":
                persist_postcall(body.get("data", {}) or {})
            return self._send(200, {"ok": True})

        return self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


def selftest(caller):
    print(f"OPENCLAW_BIN={OPENCLAW_BIN}  AGENT={OPENCLAW_AGENT_ID}  WORKSPACE={OPENCLAW_WORKSPACE}")
    print(f"persona: {len(ler_persona())} chars | histórico: {len(ler_historico(caller))} chars")
    print("\n--- resposta /init que iria pro ElevenLabs ---")
    print(json.dumps(build_init_response(caller), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "selftest":
        selftest(sys.argv[2] if len(sys.argv) > 2 else conf("WHATSAPP_NUMBER", "+5500000000000"))
        sys.exit(0)
    if not VERIFY_SIGS:
        log("⚠️  EL_VERIFY_SIGNATURES desligado — só para teste inicial. Religue em produção.")
    porta = int(conf("BRIDGE_PORT", "8077"))
    bind = conf("BRIDGE_BIND", "127.0.0.1")  # atrás do reverse proxy (Caddy); só local
    log(f"ouvindo em {bind}:{porta} (agente OpenClaw: {OPENCLAW_AGENT_ID})")
    ThreadingHTTPServer((bind, porta), H).serve_forever()
