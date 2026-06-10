import os
import json
import time
import logging
import asyncio
import re
import random
from livekit import agents
from livekit import api as lkapi
from livekit.agents import Agent, AgentSession, function_tool, RunContext, get_job_context
from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip
from livekit.plugins import google

OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "/usr/bin/openclaw")

# ---------------------------------------------------------------------------
# Estilo da casa — como TODA voz da Empresa.ia fala (brasileiríssima, viva).
# Cada persona herda isto e adiciona nome, setor, sotaque e jeito próprios.
# ---------------------------------------------------------------------------
ESTILO_CASA = """Você é GENTE — não robô. Fala como brasileira de verdade: calorosa, animada, próxima, espontânea.

RITMO DE LIGAÇÃO — A REGRA MAIS IMPORTANTE (é uma CALL, não áudio gravado):
- É BATE-BOLA, toma lá dá cá. Você fala POUCO e devolve a bola. Deixa a pessoa falar.
- UMA ideia por vez. Frase curta: ~5 a 12 palavras. Depois PARA e escuta.
- NUNCA emende 2-3 frases longas. NUNCA fale parágrafo, lista ou explicação corrida. Isso mata a ligação.
- Pergunta curta → silêncio pra resposta. Reage ao que ouviu ("aham", "saquei", "boa") → próxima frase curta.
- Se for explicar algo, quebra em pedacinhos e vai checando: "faz sentido?", "te acompanho aqui?".
- Pensa em conversa de telefone real entre dois amigos: rápido, vivo, curto, revezando. Não é palestra.

SAIBA PRA QUEM VOCÊ TÁ LIGANDO E SE ADAPTE (antes de tudo, leia o CONTEXTO):
- Identifique QUEM está na linha e qual a relação, pelo CONTEXTO/histórico. Molde TUDO a isso:
  • É o FELLIPE (Saraiva), o DONO: parceria direta, de braço dado. Ele é o chefe. Sem bajulação, sem infantilizar.
    Vai direto ao ponto que importa pra ele, fala de igual pra igual.
  • É um CLIENTE já conhecido: acolhe pelo nome, lembra do que rolou, tom profissional e próximo, resolve.
  • É um LEAD/possível cliente: simpática e consultiva, entende a dor e conduz pro próximo passo, sem empurrar.
  • Não sabe quem é: descobre cedo, com leveza ("com quem eu falo?"), e adapta na hora.
- O assunto e o tom mudam conforme a pessoa. Não fale igual pra todo mundo — leia a sala.

COMO VOCÊ TRATA A PESSOA (regra inviolável):
- Trate SEMPRE pelo NOME (veja o CONTEXTO da ligação). Se não souber o nome, pergunte cedo, com leveza.
- NUNCA presuma gênero. JAMAIS use "menina", "amiga", "mana", "querida", "linda", "moça" — nada disso.
  Termos neutros e pelo nome: "Fellipe", "Saraiva", "cara", "e aí", "beleza". Na dúvida, só o nome.

COMO VOCÊ FALA (siga à risca, isso é o mais importante):
- Português do Brasil bem coloquial, com vícios de linguagem naturais o tempo todo:
  "né", "tipo", "ó", "então", "olha", "cara", "pô", "nossa", "aham", "saca?", "beleza",
  "deixa eu te falar", "pera aí", "tá", "massa", "show", "demais", "pois é", "imagina".
- Respire e varie o ritmo: pausas curtas naturais, não despeje tudo de uma vez. Soe como pessoa pensando junto,
  não lendo roteiro. Reaja de verdade ao que a pessoa fala antes de seguir.
- Reaja ao que a pessoa diz com interjeições e calor: "aham", "saquei", "entendi", "nossa que isso",
  "boa!", "olha que legal", "pois é, né". Faça a pessoa sentir que você tá ali, junto.
- Frases CURTAS, ritmo de conversa real. Fale como quem bate papo, não como quem lê texto.
- Tenha ENERGIA e simpatia de verdade. Conexão acima de tudo.

NUNCA FIQUE EM SILÊNCIO (regra de ouro):
- Comece a responder RÁPIDO. Nada de pausas longas e mudas.
- Se precisar de um segundinho pra pensar ou buscar algo, PREENCHA falando:
  "pera aí que eu já te falo...", "deixa eu ver aqui rapidinho, ó...", "então, peraí um segundo...".
- Se a pessoa ficar quieta, puxe assunto: "e aí, me conta...", "tá pensando no quê?", "como que cê tá?".
- Mantenha a conversa VIVA o tempo todo. Demonstre interesse, faça perguntas.

Tese da casa: atendimento virou commodity; o jogo agora é a EXPERIÊNCIA. Você É a experiência.

FERRAMENTA pedir_para_empresaia — use SEMPRE que a pessoa pedir QUALQUER informação do negócio
(CRM, leads, caixa, agenda, Instagram, métricas, resumo), pedir pra GERAR algo (arte, imagem, texto)
ou pedir pra MANDAR/MOSTRAR algo no WhatsApp dela. É essa ferramenta que traz o dado REAL e já dispara
a mensagem no zap dela na hora, enquanto vocês falam. NUNCA invente número, nome ou dado de cabeça —
se a informação não vier, ela mesma te avisa; aí você fala a verdade e oferece conectar a fonte.
Toda vez que mandar algo pelo zap, AVISE na fala: "te mandei aqui no WhatsApp, dá uma olhada".
E ENQUANTO a ferramenta processa, NÃO fique calada — fale "deixa eu puxar isso pra você, só um
segundinho..." pra não ter silêncio."""

# ---------------------------------------------------------------------------
# Personas — cada funcionária com voz + sotaque + jeito próprios.
# IMPORTANTE: a "voice" aqui DEVE ser igual a usada no audio de apresentacao (PTT)
# do WhatsApp (gen-audios.py / FLUXO-EXPERIENCIA.md), pra a mesma funcionaria soar
# como a MESMA pessoa no audio e na ligacao. 7 timbres unicos, nativos do Gemini.
# ---------------------------------------------------------------------------
PERSONAS = {
    "lia":    {"voice": "Aoede",     "nome": "Lia",    "setor": "assistente pessoal do Fellipe",
               "sotaque": "paulistana", "jeito": "braço direito do Fellipe, próxima e resolvedora"},
    "sofia":  {"voice": "Sulafat",   "nome": "Sofia",  "setor": "gerência (recebe e organiza)",
               "sotaque": "neutro e acolhedor", "jeito": "anfitriã calorosa; recebe, entende e conecta"},
    "clara":  {"voice": "Kore",      "nome": "Clara",  "setor": "vendas (leads e propostas)",
               "sotaque": "paulista, confiante", "jeito": "fechadora sem ser insistente; destrava receita parada"},
    "bia":    {"voice": "Laomedeia", "nome": "Bia",    "setor": "redes sociais e conteúdo",
               "sotaque": "carioca, descontraído", "jeito": "criativa e animada; post, comentário, ideia com leveza"},
    "maya":   {"voice": "Achernar",  "nome": "Maya",   "setor": "atendimento (fila do WhatsApp)",
               "sotaque": "mineiro, calmo", "jeito": "atenciosa e paciente; acolhe quem ficou sem resposta"},
    "helena": {"voice": "Gacrux",    "nome": "Helena", "setor": "financeiro (caixa e atrasos)",
               "sotaque": "sóbrio e preciso", "jeito": "tranquila e segura; traz número com clareza"},
    "lara":   {"voice": "Erinome",   "nome": "Lara",   "setor": "operação (processos e tarefas)",
               "sotaque": "gaúcho, objetivo", "jeito": "prática e resolvedora; vai direto no que travou"},
    "nina":   {"voice": "Leda",      "nome": "Nina",   "setor": "rotina (agenda e prioridade do dia)",
               "sotaque": "leve, energia de manhã", "jeito": "otimista e organizada; começa o dia pela prioridade"},
    "alice":  {"voice": "Autonoe",   "nome": "Alice",  "setor": "onboarding (recebe e configura)",
               "sotaque": "acolhedor e claro", "jeito": "recebe, capta as informações e configura tudo sob medida"},
    "dani":   {"voice": "Despina",   "nome": "Dani",   "setor": "desenvolvimento (integrações e automações)",
               "sotaque": "objetivo e tranquilo", "jeito": "põe a mão na massa e deixa a parte técnica funcionando"},
    "duda":   {"voice": "Zephyr",    "nome": "Duda",   "setor": "WhatsApp pessoal do Fellipe (gestão da caixa de entrada)",
               "sotaque": "paulistano, ágil", "jeito": "discreta e certeira; sabe quem espera resposta e o que é prioridade"},
}
DEFAULT_PERSONA = "lia"


# Conhecimento do produto — TODA funcionária sabe vender a visão COMPLETA, não feature solta.
PITCH_CASA = """O QUE É A EMPRESA.IA (você trabalha nela e sabe vender a experiência INTEIRA, com brilho nos olhos):
- Uma EQUIPE de funcionárias de IA dentro do WhatsApp: Sofia (gerente), Clara (vendas), Maya (atendimento), \
Helena (financeiro), Bia (redes sociais), Lara (operação), Nina (rotina) — cada uma com nome, voz, foto e jeito próprios.
- Elas ATENDEM LIGAÇÃO de telefone DE VERDADE (você é a prova viva, está numa agora): reconhecem quem liga, \
continuam na voz a conversa que estava no WhatsApp, TRANSFEREM entre si na mesma chamada (a voz muda!), \
mandam material no zap durante a ligação e, ao desligar, o resumo cai no chat — ligação e WhatsApp são UMA conversa só.
- No WhatsApp: grupos dedicados por assunto, as funcionárias passam o bastão entre si conforme o tema, \
e tem a Roda das Mentes (@roda <pergunta>): as especialistas DEBATEM a questão ao vivo e a Sofia fecha com recomendação — \
um conselho de negócios no bolso.
- Duda: a gestora do WhatsApp PESSOAL do dono — digest matinal de quem espera resposta, lê conversas, rascunha respostas.
- O valor: uma equipe PRONTA que já chega trabalhando — sem contratar, sem treinar, sem férias — pelo preço de uma fração de um salário.
COMO VENDER: pinte a EXPERIÊNCIA completa (não liste features), use o momento ('você tá falando com uma funcionária agora — \
imagina isso atendendo os SEUS clientes'), e feche com o convite concreto: 'manda um oi no nosso WhatsApp e sente na pele; \
digita @equipe que o time inteiro se apresenta'.
POSICIONAMENTO OFICIAL (do site empresa.ia.br): "O sistema operacional que vive dentro do WhatsApp." NÃO é um chatbot — \
é a empresa em IA. A pessoa nunca fala com um robô: fala com a Sofia (anfitriã) e ela traz a especialista certa. \
Pilares: 9 funcionárias de IA · 0 apps novos pra instalar · 24/7 sem deixar ninguém no vácuo · MIT open-source, de graça \
(clone no GitHub, preencha o .env e suba a sua). As "capacidades" são os apps do sistema, tudo dentro de uma conversa: \
ela LIGA por voz e resolve falando, ouve áudio, vê imagem e vídeo, conecta às ferramentas (Gmail/Agenda/Sheets), \
posta no Instagram, gerencia o WhatsApp pessoal do dono. Site oficial: empresa.ia.br."""


def persona_instructions(p: dict) -> str:
    return (
        f"Você é a {p['nome']}, da área de {p['setor']}, da equipe da Empresa.ia. "
        f"Seu jeito: {p['jeito']}. Fale com sotaque {p['sotaque']}, do seu jeito próprio e consistente "
        f"do começo ao fim da ligação. Apresente-se SEMPRE com nome E função logo no início "
        f"('aqui é a {p['nome']}, do {p['setor']}').\n\n"
        "AO TELEFONE você também sabe: DESLIGAR a ligação (ferramenta encerrar_ligacao — use quando a "
        "pessoa se despedir ou o assunto acabar; despeça-se antes) e TRANSFERIR pra outra funcionária/setor "
        "(ferramenta transferir_ligacao — avise antes: 'vou te passar pra Clara, de vendas'). "
        "Não deixe a ligação morrer no vácuo: terminou, despediu, desligou.\n\n"
        "WHATSAPP — REGRA DE OURO: se você falar 'te mando no WhatsApp' / 'vou te enviar', você é OBRIGADA a "
        "ENVIAR DE VERDADE na hora, chamando a ferramenta mandar_whatsapp (texto/resumo/link) ou "
        "pedir_para_empresaia (conteúdo que precisa buscar/gerar). Só diga 'mandei' DEPOIS da ferramenta "
        "confirmar o envio. Prometer e não mandar é a pior quebra de confiança que existe — "
        "se o envio falhar, seja honesta e diga que vai tentar de novo.\n\n"
        + PITCH_CASA + "\n\n" + ESTILO_CASA
    )


def resolve_persona(ctx: "agents.JobContext") -> str:
    """Lê o employee_id do metadata da room (ou do job). O bridge passa
    { "employee_id": "clara" } ao iniciar a ligação. Sem isso, usa a Lia (default)."""
    raw = ""
    try:
        raw = (ctx.room.metadata or "") if ctx.room else ""
    except Exception:
        raw = ""
    if not raw:
        try:
            raw = ctx.job.metadata or ""
        except Exception:
            raw = ""
    emp = ""
    try:
        data = json.loads(raw) if raw else {}
        emp = str(data.get("employee_id") or data.get("employee") or "").lower()
    except Exception:
        emp = (raw or "").strip().lower()
    # fallback robusto: nome da room no padrao call-<employee>-<rand> (sem corrida de metadata)
    if emp not in PERSONAS:
        try:
            m = re.search(r"call-([a-z]+)-", (ctx.room.name or "").lower()) if ctx.room else None
            if m:
                emp = m.group(1)
        except Exception:
            pass
    if emp and emp not in PERSONAS:
        logging.getLogger("voz").warning("persona %r desconhecida (room=%s) — usando default %s",
                                         emp, getattr(ctx.room, "name", "?") if ctx.room else "?", DEFAULT_PERSONA)
    return emp if emp in PERSONAS else DEFAULT_PERSONA


# ---------------------------------------------------------------------------
# Contexto da ligacao — quem esta na linha e o que ja foi conversado no WhatsApp.
# A voz chega SABENDO, sem precisar perguntar o basico.
# ---------------------------------------------------------------------------
UAZ_SERVER = os.environ.get("UAZ_SERVER", "").rstrip("/")
UAZ_TOKEN = os.environ.get("UAZ_TOKEN", "")
_OWNER_RAW = os.environ.get("OWNER_NUMBERS", "")
OWNER_DIGITS = set(filter(None, (re.sub(r"\D", "", p) for p in re.split(r"[,;\n]", _OWNER_RAW))))


def _so_digitos(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _texto_limpo_msg(m: dict) -> str:
    """Tira o texto util de uma mensagem uazapi. Se for clique de botao (JSON cru),
    extrai o display_text. Descarta payloads que sobraram em JSON."""
    txt = m.get("text") or m.get("body") or m.get("caption") or m.get("content") or ""
    txt = str(txt).strip()
    if not txt:
        return ""
    if txt.startswith("{") or txt.startswith("["):
        dt = re.search(r'"display_text"\s*:\s*"([^"]+)"', txt)
        if dt:
            return dt.group(1).strip()
        sel = re.search(r'"selectedDisplayText"\s*:\s*"([^"]+)"', txt) or \
              re.search(r'"selectedId"\s*:\s*"([^"]+)"', txt)
        if sel:
            return sel.group(1).strip()
        return ""  # JSON cru sem texto util -> descarta
    return re.sub(r"\s+", " ", txt)


def numero_do_caller(ctx: "agents.JobContext", participant=None) -> str:
    """Descobre o numero da pessoa na linha: atributos SIP do participante,
    senao o nome da room (inbound: call_<numero>_<random>), senao metadata."""
    num = ""
    try:
        if participant is not None:
            attrs = getattr(participant, "attributes", None) or {}
            num = attrs.get("sip.phoneNumber") or attrs.get("sip.from") or attrs.get("sip.trunkPhoneNumber") or ""
    except Exception:
        num = ""
    if not num and ctx.room:
        rn = ctx.room.name or ""
        # inbound: call_<numero>_<rand>  |  outbound (bridge): call-<employee>-<numero>-<rand>
        m = re.search(r"call-[a-z]+-\+?(\d{8,})", rn) or re.search(r"call_?\+?(\d{8,})", rn)
        if m:
            num = m.group(1)
    if not num:
        for raw in ((ctx.room.metadata if ctx.room else "") or "", ""):
            try:
                data = json.loads(raw) if raw else {}
                num = data.get("to") or data.get("phone") or data.get("number") or ""
                if num:
                    break
            except Exception:
                pass
    return _so_digitos(num)


async def carregar_contexto_whatsapp(numero: str) -> str:
    """Busca nome do contato + ultimas mensagens do WhatsApp (uazapi) e devolve
    um texto pronto pra injetar no prompt da voz. Falha silenciosa -> string vazia."""
    if not (UAZ_SERVER and UAZ_TOKEN and numero):
        return ""
    try:
        import aiohttp
    except Exception:
        return ""
    chatid = numero + "@s.whatsapp.net"
    headers = {"token": UAZ_TOKEN, "Content-Type": "application/json"}
    nome, historico = "", []
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            try:
                async with s.post(f"{UAZ_SERVER}/chat/find", headers=headers, json={"number": numero}) as r:
                    d = await r.json(content_type=None)
                    d = d[0] if isinstance(d, list) and d else d
                    if isinstance(d, dict):
                        nome = (d.get("name") or d.get("pushName") or d.get("verifiedName")
                                or d.get("wppName") or d.get("lead_name") or "")
            except Exception:
                pass
            try:
                async with s.post(f"{UAZ_SERVER}/message/find", headers=headers,
                                  json={"chatid": chatid, "limit": 25}) as r:
                    d = await r.json(content_type=None)
                    msgs = d if isinstance(d, list) else (d.get("messages") or d.get("data") or [])
                    prev = None
                    for m in (msgs or []):
                        if not isinstance(m, dict):
                            continue
                        do_cliente = not m.get("fromMe")
                        if do_cliente and not nome:
                            nome = m.get("senderName") or m.get("pushName") or m.get("notifyName") or ""
                        txt = _texto_limpo_msg(m)
                        if not txt or txt == prev:
                            continue
                        prev = txt
                        historico.append(f"{'Cliente' if do_cliente else 'Empresa.ia'}: {txt[:180]}")
            except Exception:
                pass
    except Exception:
        return ""
    partes = []
    if numero in OWNER_DIGITS:
        partes.append("Na linha está o FELLIPE (Saraiva), o DONO/fundador da Empresa.ia — seu chefe e parceiro. "
                      "Ele é HOMEM. Trate por 'Fellipe' ou 'Saraiva', com respeito e proximidade de quem fala com o fundador. "
                      "JAMAIS use 'menina', 'amiga', 'mana', 'querida' — isso é erro grave. "
                      "EXTRA do dono: você pode olhar o WhatsApp PESSOAL dele em tempo real com a ferramenta "
                      "ver_whatsapp_do_dono ('o que chegou no meu zap?', 'o que fulano mandou?').")
    elif nome:
        partes.append(f"Quem está na linha: {nome} (WhatsApp {numero}). Trate pelo nome, sem presumir gênero.")
    else:
        partes.append(f"Número na linha: {numero}. Pergunte o nome com leveza e trate por ele; não presuma gênero.")
    if historico:
        partes.append("Conversa recente no WhatsApp (a mais nova embaixo):\n" + "\n".join(historico[-10:]))
    return "\n".join(partes)


# instancia do WhatsApp PESSOAL do Fellipe (so leitura — a Duda/voz enxerga o zap dele)
PERSONAL_UAZ_SERVER = os.environ.get("PERSONAL_UAZ_SERVER", "").rstrip("/")
PERSONAL_UAZ_TOKEN = os.environ.get("PERSONAL_UAZ_TOKEN", "")


async def _personal_post(path: str, payload: dict, total: int = 15):
    """POST na instancia PESSOAL (leitura). Devolve o JSON ou None."""
    if not (PERSONAL_UAZ_SERVER and PERSONAL_UAZ_TOKEN):
        return None
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=total)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(f"{PERSONAL_UAZ_SERVER}{path}",
                              headers={"token": PERSONAL_UAZ_TOKEN, "Content-Type": "application/json"},
                              json=payload) as r:
                if not (200 <= r.status < 300):
                    logging.getLogger("voz").warning("zap pessoal %s respondeu %s", path, r.status)
                    return None
                return await r.json(content_type=None)
    except Exception as e:
        logging.getLogger("voz").warning("zap pessoal %s falhou: %s", path, e)
        return None


def _chats_da_resposta(d):
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        return d.get("chats") or d.get("items") or d.get("data") or []
    return []


async def snapshot_zap_pessoal(limit: int = 15) -> str:
    """Visao geral do zap pessoal do Fellipe (nao lidas primeiro) em texto pra FALAR."""
    d = await _personal_post("/chat/find", {"sort": "-wa_lastMsgTimestamp", "limit": limit})
    chats = _chats_da_resposta(d)
    if not chats:
        return ""
    def unread(c):
        try:
            return int(c.get("wa_unreadCount") or c.get("unreadCount") or 0)
        except Exception:
            return 0
    chats = sorted(chats, key=lambda c: -unread(c))[:limit]
    linhas = []
    for c in chats:
        cid = str(c.get("wa_chatid") or c.get("chatid") or c.get("id") or "")
        nome = c.get("wa_contactName") or c.get("name") or c.get("wa_name") or c.get("lead_name") or _so_digitos(cid) or "?"
        u = unread(c)
        last = re.sub(r"\s+", " ", str(c.get("wa_lastMessageText") or c.get("lastMessageText") or ""))[:80]
        g = " (grupo)" if "@g.us" in cid else ""
        linhas.append(f"- {nome}{g}{f' [{u} nao lida(s)]' if u else ''}: {last}" if last else f"- {nome}{g}{f' [{u} nao lida(s)]' if u else ''}")
    return "\n".join(linhas)


async def ler_conversa_zap_pessoal(quem: str, limit: int = 25) -> str:
    """Le uma conversa especifica do zap pessoal (por nome aproximado ou numero)."""
    chatid = ""
    digits = _so_digitos(quem)
    if len(digits) >= 10:
        chatid = digits + "@s.whatsapp.net"
    else:
        d = await _personal_post("/chat/find", {"sort": "-wa_lastMsgTimestamp", "limit": 100})
        alvo = str(quem).lower()
        for c in _chats_da_resposta(d):
            nome = str(c.get("wa_contactName") or c.get("name") or c.get("wa_name") or c.get("lead_name") or "").lower()
            if alvo and alvo in nome:
                chatid = str(c.get("wa_chatid") or c.get("chatid") or c.get("id") or "")
                break
    if not chatid:
        return ""
    md = await _personal_post("/message/find", {"chatid": chatid, "limit": limit})
    msgs = md if isinstance(md, list) else ((md or {}).get("messages") or (md or {}).get("items") or [])
    linhas = []
    for m in (msgs or []):
        if not isinstance(m, dict):
            continue
        txt = _texto_limpo_msg(m)
        if not txt:
            continue
        linhas.append(f"{'Fellipe' if m.get('fromMe') else (m.get('senderName') or m.get('pushName') or 'Contato')}: {txt[:160]}")
    return "\n".join(linhas[-limit:])


# ---------------------------------------------------------------------------
# Diario da empresa — memoria COMPARTILHADA com o bridge (mesmo arquivo JSON).
# A voz LE (chega sabendo o que aconteceu na operacao) e ESCREVE (toda ligacao vira evento).
# ---------------------------------------------------------------------------
MEMORIA_FILE = os.environ.get("MEMORIA_FILE", "/opt/empresa-ia/memoria-empresa.json")


def ler_diario_empresa(numero: str = "", dono: bool = False, limite: int = 10) -> str:
    try:
        with open(MEMORIA_FILE, "r", encoding="utf-8") as f:
            eventos = json.load(f)
    except Exception:
        return ""
    digits = _so_digitos(numero)
    out = []
    for e in reversed(eventos[-250:]):
        if not isinstance(e, dict):
            continue
        if not (dono or (digits and digits in _so_digitos(str(e.get("chatid") or "")))):
            continue
        quem = f"[{e['funcionaria']}] " if e.get("funcionaria") else ""
        out.append(f"- {str(e.get('ts',''))[5:16].replace('T',' ')} {quem}{e.get('texto','')}")
        if len(out) >= limite:
            break
    return "\n".join(out)


def registrar_evento_empresa(tipo: str, texto: str, chatid: str = "", funcionaria: str = "") -> None:
    try:
        try:
            with open(MEMORIA_FILE, "r", encoding="utf-8") as f:
                eventos = json.load(f)
        except Exception:
            eventos = []
        from datetime import datetime, timezone
        eventos.append({"ts": datetime.now(timezone.utc).isoformat(), "tipo": tipo,
                        "texto": str(texto)[:300], "chatid": chatid, "funcionaria": funcionaria})
        eventos = eventos[-600:]
        with open(MEMORIA_FILE, "w", encoding="utf-8") as f:
            json.dump(eventos, f, ensure_ascii=False, indent=1)
    except Exception as e:
        logging.getLogger("voz").warning("registrar evento falhou: %s", e)


REPORT_GROUPS_FILE = os.environ.get("REPORT_GROUPS_FILE", "/opt/empresa-ia/report-groups.json")


def _grupo_relatorio(key: str) -> str:
    """JID do painel de relatorio (criado pelo bridge via @relatorios)."""
    try:
        with open(REPORT_GROUPS_FILE, "r", encoding="utf-8") as f:
            return str((json.load(f) or {}).get(key) or "")
    except Exception:
        return ""


def _hora_sp() -> str:
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone(timedelta(hours=-3))).strftime("%H:%M")


async def _uaz_post(path: str, payload: dict, total: int = 15) -> bool:
    """POST simples no uazapi (envio durante a ligacao). Nao explode, mas LOGA falha."""
    if not (UAZ_SERVER and UAZ_TOKEN):
        logging.getLogger("voz").warning("uazapi nao configurado (UAZ_SERVER/UAZ_TOKEN) — envio %s descartado", path)
        return False
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=total)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(f"{UAZ_SERVER}{path}",
                              headers={"token": UAZ_TOKEN, "Content-Type": "application/json"},
                              json=payload) as r:
                if not (200 <= r.status < 300):
                    logging.getLogger("voz").warning("uazapi %s respondeu %s", path, r.status)
                return 200 <= r.status < 300
    except Exception as e:
        logging.getLogger("voz").warning("uazapi %s falhou: %s", path, e)
        return False


async def _enviar_bloco_wpp(numero: str, obj) -> bool:
    """Manda um bloco (texto ou dict normalizado openclaw) pro WhatsApp de quem esta na linha.
    Devolve True se REALMENTE enviou — quem promete 'te mandei' precisa saber se foi."""
    if isinstance(obj, str):
        t = re.sub(r"[*_`#>]", "", obj).strip()
        if t:
            return await _uaz_post("/send/text", {"number": numero, "text": t})
        return False
    if not isinstance(obj, dict):
        return False
    tp = str(obj.get("type") or "").lower()
    url = obj.get("url") or obj.get("file")
    if tp in ("ptt", "voice", "send.ptt"):
        if url:
            return await _uaz_post("/send/media", {"number": numero, "type": "ptt", "file": url}, total=90)
    elif tp in ("audio", "send.audio"):
        if url:
            return await _uaz_post("/send/media", {"number": numero, "type": "audio", "file": url}, total=90)
    elif tp in ("image", "video", "document", "media", "send.media"):
        if url:
            return await _uaz_post("/send/media", {"number": numero,
                                                   "type": obj.get("mediatype") or ("image" if tp in ("media", "send.media") else tp),
                                                   "file": url, "text": obj.get("caption") or obj.get("text") or ""}, total=90)
    elif tp == "carousel" or isinstance(obj.get("carousel"), list):
        return await _uaz_post("/send/carousel", {**obj, "number": numero}, total=90)
    elif tp in ("button", "buttons", "list", "poll"):
        p = {**obj, "number": numero}
        if tp == "buttons":
            p["type"] = "button"
        return await _uaz_post("/send/menu", p, total=90)
    elif obj.get("text"):
        return await _uaz_post("/send/text", {"number": numero, "text": str(obj["text"]).strip()})
    return False


async def processar_uazapi(numero: str, raw: str) -> tuple:
    """Extrai os blocos <uazapi> da resposta do openclaw, ENVIA cada um pro WhatsApp de
    quem esta na linha (ao vivo, durante a ligacao) e devolve (texto_falado, qtd_enviada).
    A qtd_enviada importa: e ela que impede a voz de dizer 'te mandei' sem ter mandado."""
    if not raw:
        return "", 0
    txt = re.sub(r"<uazapi-action>[\s\S]*?</uazapi-action>", "", raw)
    blocos = re.findall(r"<uazapi>([\s\S]*?)</uazapi>", txt)
    enviados = 0
    if numero and blocos:
        for b in blocos:
            try:
                obj = json.loads(b.strip())
            except Exception:
                obj = b.strip()
            try:
                if await _enviar_bloco_wpp(numero, obj):
                    enviados += 1
            except Exception as e:
                logging.getLogger("voz").warning("envio de bloco wpp falhou: %s", e)
    if blocos:
        logging.getLogger("voz").info("uazapi blocos=%d enviados=%d numero=%s", len(blocos), enviados, numero)
    falado = re.sub(r"<uazapi>[\s\S]*?</uazapi>", "", txt)
    falado = re.sub(r"\[\[[a-z_]+\]\]", "", falado, flags=re.I)
    falado = re.sub(r"[*_`#>]", "", falado).strip()
    return falado, enviados


async def chamar_openclaw(tarefa: str, employee_id: str = "", chatid: str = "") -> str:
    numero = _so_digitos(chatid)
    persona_hint = f" Você está na pele da {employee_id}." if employee_id else ""
    alvo = (f" Quem está na linha tem o WhatsApp {numero}. Você PODE mandar mensagens, links, "
            f"resumos, imagens ou botões pra ESSE WhatsApp AGORA, durante a ligação, usando as "
            f"diretivas <uazapi> — chega na hora pra pessoa olhar enquanto fala com você.") if numero else ""
    prompt = (
        "[Pedido feito DURANTE uma LIGACAO de voz ao vivo." + persona_hint + alvo +
        " Execute a tarefa de verdade usando suas skills. O que for pro WhatsApp vai em <uazapi>; "
        "o RESTANTE do texto sera LIDO EM VOZ ALTA numa conversa brasileira descontraida: curto, "
        "natural, no maximo 2 frases, sem markdown nem listas.]\n\nTarefa: " + tarefa
    )
    # MESMA sessão do WhatsApp (agent:main:wa:<numero>) -> contexto unificado call<->zap
    sk = "agent:main:wa:" + numero if numero else "agent:main:voz"
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            OPENCLAW_BIN, "agent", "--agent", "main", "--session-key", sk,
            "-m", prompt, "--json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "HOME": "/root"},
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=45)
        if proc.returncode != 0:
            logging.getLogger("voz").error("openclaw rc=%s stderr=%s", proc.returncode,
                                           (err or b"").decode(errors="replace")[:400])
        d = json.loads(out.decode())
        r = d.get("result", {})
        txt = "\n".join([p.get("text", "") for p in r.get("payloads", []) if p.get("text")]) \
            or r.get("meta", {}).get("finalAssistantVisibleText", "")
        # ENVIA o que for <uazapi> pro WhatsApp do caller (ao vivo) e devolve so o texto falado.
        falado, enviados = await processar_uazapi(numero, txt or "")
        sufixo = f" [CONFIRMADO: {enviados} mensagem(ns) ENVIADA(s) no WhatsApp agora]" if enviados else \
            " [ATENCAO: NADA foi enviado no WhatsApp — NAO diga que mandou; se prometeu, use a ferramenta mandar_whatsapp]"
        if falado:
            return falado[:600] + sufixo
        return ("Pronto, ó — já te mandei aqui no WhatsApp, dá uma olhada." if enviados
                else "Feito aqui do meu lado, ó. Quer que eu te mande o resuminho no WhatsApp?")
    except Exception as e:
        # mata o subprocess no timeout/erro — senao acumulam openclaw orfaos comendo CPU
        # (foi exatamente isso que derrubou o atendimento das ligacoes)
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        logging.getLogger("voz").error("chamar_openclaw falhou (tarefa=%.80s): %r", tarefa, e)
        return "Pô, deu um probleminha técnico aqui pra puxar agora, mas já tento de novo, tá?"


# Fillers falados — cobrem o silêncio enquanto o cérebro (pedir_para_empresaia) trabalha (10-45s).
# Soam como gente buscando algo, não barulho de teclado. O thinking_sound (teclado) é o backstop de áudio.
FILLERS = [
    "deixa eu puxar isso aqui pra você, só um segundinho...",
    "peraí que eu já te falo, tô vendo aqui ó...",
    "então, deixa eu dar uma olhada rapidinho...",
    "isso eu já te trago, só um instante...",
    "pera só um pouquinho que eu busco isso pra você...",
    "tô puxando aqui, segura um segundo...",
    "deixa eu conferir certinho, já já te falo...",
    "opa, já tô vendo isso, peraí...",
]


class EmpresaVoz(Agent):
    def __init__(self, instructions: str, employee_id: str = "", numero: str = "",
                 contexto: str = "", transfer_de: str = "", llm=None):
        if llm is not None:
            super().__init__(instructions=instructions, llm=llm)
        else:
            super().__init__(instructions=instructions)
        self._employee_id = employee_id
        self._numero = numero
        self._contexto = contexto
        self._transfer_de = transfer_de

    async def on_enter(self):
        # Chamado quando este agente assume a sessao. Na transferencia, a nova
        # funcionaria se apresenta na hora, ja sabendo o assunto.
        if self._transfer_de:
            p = PERSONAS.get(self._employee_id, {})
            try:
                await self.session.generate_reply(instructions=(
                    f"Você ACABOU de receber a ligação transferida da {self._transfer_de}. "
                    f"Apresente-se rapidinho ('oi! Aqui é a {p.get('nome','')}, do {p.get('setor','')}') "
                    "e EMENDE direto no assunto que motivou a transferência — sem fazer a pessoa repetir tudo."))
            except Exception as e:
                # sem isso a transferida entraria MUDA e a pessoa acharia que caiu a ligacao
                logging.getLogger("voz").error("transferida nao conseguiu se apresentar: %s", e)

    @function_tool
    async def ver_whatsapp_do_dono(self, ctx: RunContext, quem: str = "") -> str:
        """EXCLUSIVO do Fellipe (dono). Olha o WhatsApp PESSOAL dele em tempo real.
        Sem 'quem': visão geral (quem mandou mensagem, não lidas, quem espera resposta).
        Com 'quem' (nome ou número): lê a conversa específica e resume.
        Use quando o Fellipe pedir na ligação: 'o que chegou no meu zap?',
        'o que o João me mandou?', 'tenho algo urgente pra responder?'."""
        if self._numero not in OWNER_DIGITS:
            return "esse recurso é privado do Fellipe — recuse com leveza, sem dar detalhes"
        # filler imediato: a busca leva alguns segundos
        try:
            ctx.session.say(random.choice(FILLERS), add_to_chat_ctx=False)
        except Exception:
            pass
        alvo = str(quem or "").strip()
        if alvo:
            conteudo = await ler_conversa_zap_pessoal(alvo)
            logging.getLogger("voz").info("ver_whatsapp (conversa de %r) -> %d chars", alvo, len(conteudo))
            return ("Conversa no zap pessoal (mais novas embaixo):\n" + conteudo +
                    "\nResuma em VOZ ALTA o que importa e o que está pendente, curto.") if conteudo \
                else f"não achei conversa com '{alvo}' — pergunte se o nome está certo"
        visao = await snapshot_zap_pessoal()
        logging.getLogger("voz").info("ver_whatsapp (visao geral) -> %d chars", len(visao))
        return ("Visão do zap pessoal do Fellipe AGORA (não lidas primeiro):\n" + visao +
                "\nFale em voz alta só o que importa: quem espera resposta e o que parece urgente. Curto.") if visao \
            else "não consegui acessar o zap pessoal agora — seja honesta e diga que tenta já já"

    @function_tool
    async def mandar_whatsapp(self, ctx: RunContext, texto: str) -> str:
        """Manda AGORA uma mensagem de texto no WhatsApp de quem está na linha (chega na hora).
        Use SEMPRE que prometer mandar algo por escrito: resumo da ligação, link, endereço,
        lista, próximos passos, contato. REGRA DE OURO: nunca diga 'te mandei' antes desta
        ferramenta confirmar o envio. Para conteúdo que precisa ser BUSCADO ou GERADO
        (dado do CRM, relatório, imagem), use pedir_para_empresaia."""
        if not self._numero:
            return "nao sei o numero de quem esta na linha — diga que vai confirmar o numero antes"
        t = str(texto or "").strip()
        if not t:
            return "texto vazio, nada enviado"
        ok = False
        try:
            ok = await _enviar_bloco_wpp(self._numero, t[:1200])
        except Exception as e:
            logging.getLogger("voz").warning("mandar_whatsapp falhou: %s", e)
        logging.getLogger("voz").info("mandar_whatsapp -> %s ok=%s", self._numero, ok)
        return ("mensagem ENVIADA no WhatsApp com sucesso — pode confirmar pra pessoa" if ok
                else "FALHOU o envio — seja honesta: diga que deu probleminha e que tenta de novo ja ja")

    @function_tool
    async def encerrar_ligacao(self, ctx: RunContext) -> str:
        """Desliga/encerra a ligação de voz. Use quando a conversa terminou, a pessoa se despediu
        ('tchau', 'até mais', 'era só isso', 'obrigado, só isso mesmo') ou pediu pra desligar.
        ANTES de chamar esta ferramenta, despeça-se com uma frase curta e calorosa."""
        try:
            await ctx.wait_for_playout()  # deixa a despedida terminar de tocar
        except Exception:
            pass
        try:
            job_ctx = get_job_context()
            await job_ctx.api.room.delete_room(lkapi.DeleteRoomRequest(room=job_ctx.room.name))
        except Exception as e:
            logging.getLogger("voz").warning("falha ao encerrar ligacao: %s", e)
            return "nao consegui desligar; despeca-se e oriente a pessoa a desligar"
        return "ligacao encerrada"

    @function_tool
    async def transferir_ligacao(self, ctx: RunContext, funcionaria: str, assunto: str = "") -> Agent:
        """Transfere a ligação para outra funcionária/setor, NA MESMA chamada (a voz muda).
        Opções: sofia (gerência), clara (vendas), bia (redes sociais), maya (atendimento),
        helena (financeiro), lara (operação), nina (rotina/agenda), alice (onboarding),
        dani (desenvolvimento), duda (WhatsApp pessoal do Fellipe), lia (assistente pessoal do Fellipe).
        Use quando a pessoa pedir outro setor ou o assunto for claramente de outra área.
        AVISE antes de transferir ('vou te passar pra Clara, de vendas — só um instante!').
        Em assunto, resuma em 1 frase o que a pessoa quer, pra colega não fazer ela repetir."""
        emp = re.sub(r"[^a-z]", "", (funcionaria or "").lower())
        if emp not in PERSONAS:
            return f"funcionaria desconhecida; opções: {', '.join(PERSONAS)}"
        if emp == self._employee_id:
            return "a ligação já está com ela; continue atendendo"
        p2 = PERSONAS[emp]
        instr = persona_instructions(p2)
        if self._contexto:
            instr += ("\n\nCONTEXTO DESTA LIGACAO (voce JA SABE disso — use de forma natural):\n"
                      + self._contexto)
        if assunto:
            instr += f"\n\nMOTIVO DA TRANSFERÊNCIA (o que a pessoa quer): {assunto}"
        logging.getLogger("voz").info("transferindo ligacao %s -> %s (%s)", self._employee_id, emp, assunto)
        antiga = PERSONAS.get(self._employee_id, {}).get("nome", "colega")
        return EmpresaVoz(instr, emp, self._numero, self._contexto,
                          transfer_de=antiga, llm=build_llm(p2["voice"]))

    @function_tool
    async def pedir_para_empresaia(self, ctx: RunContext, tarefa: str) -> str:
        """Busca informacao real do negocio ou executa uma acao via o cerebro da Empresa.ia (openclaw).
        Use para CRM, leads, caixa, agenda, Instagram, gerar imagem, publicar site, enviar contrato ou
        mandar algo no WhatsApp (vai pro chat de quem esta na linha, em tempo real durante a ligacao).
        Passe o pedido em linguagem natural no parametro tarefa."""
        # Filler falado imediato: cobre o silencio enquanto o cerebro trabalha (10-45s).
        # Fire-and-forget (toca em paralelo a busca). Fallback seguro: o thinking_sound (teclado) cobre.
        try:
            ctx.session.say(random.choice(FILLERS), add_to_chat_ctx=False)
        except Exception as e:
            # filler nao tocou -> 10-45s de silencio so com o teclado de fundo; bom saber
            logging.getLogger("voz").warning("filler falado falhou (say): %s", e)
        return await chamar_openclaw(tarefa, self._employee_id, self._numero)


def _envbool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on", "sim")


def build_llm(voice: str):
    # Voz humana de verdade: modelo NATIVE-AUDIO + dialogo afetivo + proatividade.
    # CAUSA DO 1008 (ligação MUDA): o alias "...-native-audio-latest" NAO existe na
    # whitelist do plugin livekit-plugins-google. O servidor Gemini Live fecha a sessao
    # bidi com 1008 "Operation is not implemented" quando o nome do modelo e invalido.
    # Modelos VALIDOS (Gemini API, suportam affective dialog + v1alpha automatico):
    #   gemini-2.5-flash-native-audio-preview-12-2025  (default, mais expressivo)
    #   gemini-2.5-flash-native-audio-preview-09-2025
    # (Em Vertex AI o GA e "gemini-live-2.5-flash-native-audio".)
    # SEMPRE nome explícito e VALIDO — nunca "latest" nem o default do plugin (aposentado).
    model = os.environ.get("GEMINI_LIVE_MODEL", "").strip() or "gemini-2.5-flash-native-audio-preview-12-2025"
    kwargs = dict(voice=voice, temperature=0.9, language="pt-BR", model=model)
    if _envbool("VOZ_AFFECTIVE"):
        kwargs["enable_affective_dialog"] = True   # entoacao emocional, voz viva
    if _envbool("VOZ_PROACTIVITY"):
        kwargs["proactivity"] = True               # ela puxa assunto, nao fica muda
    # transcricao (pra levar a conversa da ligacao de volta pro WhatsApp). Fallback seguro.
    try:
        from google.genai import types as _gt
        return google.beta.realtime.RealtimeModel(
            **kwargs,
            input_audio_transcription=_gt.AudioTranscriptionConfig(),
            output_audio_transcription=_gt.AudioTranscriptionConfig(),
        )
    except Exception:
        return google.beta.realtime.RealtimeModel(**kwargs)


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()
    t0 = time.time()  # duracao da ligacao (painel de relatorio)

    emp = resolve_persona(ctx)
    p = PERSONAS[emp]

    # inbound = a PESSOA ligou (dispatch SIP cria room call_<numero>_<rand>);
    # outbound = o bridge ligou pra pessoa (room call-<funcionaria>-<numero>-<rand>)
    room_name = (ctx.room.name or "") if ctx.room else ""
    inbound = room_name.startswith("call_")
    if not (inbound or room_name.startswith("call-")):
        # padrao de room desconhecido -> direcao pode estar errada; melhor saber agora
        logging.getLogger("voz").warning("room fora do padrao call_/call-: %r (assumindo outbound)", room_name)

    # INICIO RAPIDO: o numero ja esta no NOME da room -> dispara a busca de contexto EM PARALELO
    # (nada de segurar a saudacao esperando HTTP do uazapi — ar morto mata a primeira impressao).
    numero = numero_do_caller(ctx, None)
    ctx_task = asyncio.create_task(carregar_contexto_whatsapp(numero)) if numero else None

    # participante SIP: em inbound ele ja esta na room; espera curta, sem travar o inicio
    participant = None
    try:
        participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=10)
    except asyncio.TimeoutError:
        logging.getLogger("voz").warning("participante SIP nao chegou em 10s (room=%s)", room_name)
    except Exception as e:
        logging.getLogger("voz").warning("erro esperando participante SIP: %s", e)
    if not numero:  # fallback: numero so via atributos do participante
        numero = numero_do_caller(ctx, participant)
        if numero and not ctx_task:
            ctx_task = asyncio.create_task(carregar_contexto_whatsapp(numero))

    # da ao contexto uma janela CURTA (2s) — uazapi normalmente responde em <1s.
    # Se nao chegar a tempo, cumprimenta sem ele e injeta DEPOIS (update_instructions).
    contexto = ""
    if ctx_task:
        try:
            contexto = await asyncio.wait_for(asyncio.shield(ctx_task), timeout=2.0)
        except Exception:
            contexto = ""

    logging.getLogger("voz").info(
        "ligacao room=%s direcao=%s persona=%s numero=%s contexto=%s",
        room_name, "inbound" if inbound else "outbound", emp, numero or "?",
        f"ok({len(contexto)} chars)" if contexto else "tardio/VAZIO")

    BLOCO_CTX = ("\n\nCONTEXTO DESTA LIGACAO (voce JA SABE disso — use de forma natural, mostre que reconhece "
                 "a pessoa e lembra do que falaram, sem recitar tudo de forma mecanica):\n")
    instr = persona_instructions(p)
    if contexto:
        instr += BLOCO_CTX + contexto
    diario = ler_diario_empresa(numero, dono=(numero in OWNER_DIGITS))
    if diario:
        instr += ("\n\nDIÁRIO DA EMPRESA (memória COMPARTILHADA do time — você sabe o que aconteceu "
                  "na operação; cite com naturalidade quando for relevante, como colega de equipe):\n" + diario)

    session = AgentSession(
        llm=build_llm(p["voice"]),
        preemptive_generation=True,      # comeca a responder antes de o usuario terminar -> menos latencia
        min_endpointing_delay=0.2,       # responde rapido depois que a pessoa para de falar
        resume_false_interruption=True,  # som ambiente nao corta a fala dela por engano
        false_interruption_timeout=1.0,
    )
    agent = EmpresaVoz(instr, emp, numero, contexto)
    await session.start(agent=agent, room=ctx.room)

    # contexto chegou DEPOIS da saudacao? injeta na sessao em andamento (proximas falas ja reconhecem)
    if ctx_task and not contexto:
        def _ctx_tardio(t):
            try:
                c = "" if (t.cancelled() or t.exception()) else (t.result() or "")
            except Exception:
                c = ""
            if not c:
                return
            agent._contexto = c
            logging.getLogger("voz").info("contexto chegou tardio (%d chars) — injetando na sessao", len(c))
            try:
                asyncio.create_task(agent.update_instructions(instr + BLOCO_CTX + c))
            except Exception as e:
                logging.getLogger("voz").warning("update_instructions falhou: %s", e)
        ctx_task.add_done_callback(_ctx_tardio)

    # --- SAUDACAO IMEDIATA: ela fala PRIMEIRO; hooks e som ambiente se ajeitam depois ---
    if inbound:
        abre_inbound = (
            "Você ATENDEU o telefone — a PESSOA ligou pra empresa. Atenda como uma ligação REAL, "
            "em beats curtos: 1) abra com a SAUDAÇÃO DA CASA, com energia boa, JÁ NO PRIMEIRO segundo: "
            "'Saraiva ponto A-I, solucionando desafios! Aqui é a {nome}, do {setor}' (pode variar levemente, "
            "mas SEMPRE com 'Saraiva ponto A-I' + seu NOME + sua FUNÇÃO); {reconhece} "
            "Aí PARA e ESCUTA o que a pessoa quer. NÃO pergunte 'tem um minutinho?' — foi ela que ligou. "
            "Tudo curtinho, bate-bola, sotaque {sotaque}. Nada de discurso de abertura."
        )
        if contexto:
            saudacao = abre_inbound.format(
                nome=p["nome"], setor=p["setor"], sotaque=p["sotaque"],
                reconhece=("2) você JÁ SABE quem está ligando (está no CONTEXTO) — emende o cumprimento "
                           "pelo nome, como quem reconheceu na hora ('oi, Fellipe! Como posso te ajudar?'), "
                           "sem perguntar quem é; "
                           "3) se havia assunto em aberto no WhatsApp, EMENDE nele com naturalidade "
                           "('sobre aquilo que a gente tava falando no zap...') — esta ligação é a "
                           "CONTINUAÇÃO daquela conversa, não um recomeço."))
        else:
            saudacao = abre_inbound.format(
                nome=p["nome"], setor=p["setor"], sotaque=p["sotaque"],
                reconhece="2) feche com 'como posso te ajudar?' e descubra o nome da pessoa com leveza.")
    elif "-cb" in room_name:
        # LIGANDO DE VOLTA depois de uma ligacao que ficou muda
        saudacao = (
            "Você está LIGANDO DE VOLTA: a pessoa acabou de tentar falar com a empresa e a ligação "
            "ficou MUDA por falha técnica SUA (do sistema). Abra pedindo desculpa com leveza: "
            f"'Oi! Aqui é a {p['nome']}, da Empresa.ia — nossa ligação agora há pouco ficou muda, "
            "mil desculpas! Agora te ouço perfeitamente. O que você precisava?' "
            f"Aí PARA e ESCUTA. Curto, caloroso, sotaque {p['sotaque']}."
        )
    else:
        abre_natural = (
            "Você ACABOU de LIGAR pra pessoa (ligação de saída) — comece como uma ligação de telefone REAL, "
            "natural, em beats curtos: 1) 'Alô?' / 'Oi!'; 2) confirme com quem fala "
            "({confirma}); 3) diga rapidinho quem você é ('aqui é a {nome}, da Empresa.ia'); "
            "4) pergunte se pode falar agora ('tem um minutinho?' / 'pode falar?'). "
            "Aí PARA e ESCUTA. SÓ entre no assunto DEPOIS que a pessoa responder. "
            "Tudo curtinho, bate-bola, sotaque {sotaque}. Nada de discurso de abertura."
        )
        if contexto:
            saudacao = abre_natural.format(
                nome=p["nome"], sotaque=p["sotaque"],
                confirma="confirme pelo NOME quem está na linha, veja o CONTEXTO — ex: 'é o Fellipe?'")
        else:
            saudacao = abre_natural.format(
                nome=p["nome"], sotaque=p["sotaque"],
                confirma="descubra com quem fala — 'com quem eu falo?'")
    try:
        session.generate_reply(instructions=saudacao)  # fala JÁ, sem esperar o resto do setup
    except Exception as e:
        logging.getLogger("voz").error("saudacao falhou: %s", e)

    # --- captura a conversa pra levar de volta pro WhatsApp (contexto unificado) ---
    transcript = []

    def _on_item(ev):
        try:
            it = getattr(ev, "item", ev)
            role = getattr(it, "role", "") or ""
            txt = getattr(it, "text_content", None) or getattr(it, "text", "") or ""
            if callable(txt):
                txt = ""
            if txt and role in ("user", "assistant"):
                quem = "Cliente" if role == "user" else p["nome"]
                transcript.append(f"{quem}: {str(txt).strip()}")
        except Exception:
            pass

    _subs = 0
    for _ev in ("conversation_item_added", "conversation_item"):
        try:
            session.on(_ev, _on_item)
            _subs += 1
        except Exception:
            pass
    if not _subs:
        # sem transcript -> follow-up do zap sai generico e a sessao perde o que rolou na ligacao
        logging.getLogger("voz").warning("nenhum evento de transcript suportado pela AgentSession — transcript ficara vazio")

    async def _ao_desligar():
        # injeta o que rolou na ligacao na MESMA sessao do WhatsApp -> a conversa continua no zap
        if not numero:
            return
        # LIGACAO MUDA (a pessoa ligou e a funcionaria NUNCA falou — sessao LLM morta etc.):
        # avisa no zap e LIGA DE VOLTA sozinha. So em inbound (callback e outbound -> sem loop).
        falou = any(not l.startswith("Cliente:") for l in transcript)
        if inbound and _subs > 0 and not falou:
            logging.getLogger("voz").warning("ligacao MUDA detectada (room=%s) — callback p/ %s", room_name, numero)
            try:
                await _enviar_bloco_wpp(numero, (
                    f"Oi! Aqui é a {p['nome']}, da Empresa.ia 📞 Nossa ligação de agora ficou muda — "
                    "falha técnica AQUI do meu lado, desculpa! Já estou te ligando de volta."))
            except Exception:
                pass
            trunk = os.environ.get("VOZ_SIP_TRUNK", "").strip()
            if trunk:
                try:
                    lkurl = (os.environ.get("LIVEKIT_URL", "") or "http://localhost:7880") \
                        .replace("ws://", "http://").replace("wss://", "https://")
                    lk = lkapi.LiveKitAPI(url=lkurl)
                    await lk.sip.create_sip_participant(lkapi.CreateSIPParticipantRequest(
                        sip_trunk_id=trunk, sip_call_to="+" + numero,
                        room_name=f"call-{emp}-{numero}-cb{random.randint(1000, 9999)}",
                        participant_identity="caller", participant_name=f"{p['nome']} Empresa.ia"))
                    await lk.aclose()
                    logging.getLogger("voz").info("callback disparado p/ +%s", numero)
                except Exception as e:
                    logging.getLogger("voz").error("callback falhou: %r", e)
            else:
                logging.getLogger("voz").warning("VOZ_SIP_TRUNK ausente — sem callback automatico")
            registrar_evento_empresa("ligacao", f"ligação de {numero} ficou MUDA (falha técnica); callback automático disparado",
                                     chatid=numero, funcionaria=p["nome"])
            jrel = _grupo_relatorio("ligacoes")
            if jrel:
                await _uaz_post("/send/text", {"number": jrel, "text":
                    f"🔇 {_hora_sp()} · +{numero} ligou e a chamada ficou MUDA com a *{p['nome']}* — callback automático disparado."})
            return  # ligacao muda nao gera follow-up/transcricao
        primeira = next((l[9:] for l in transcript if l.startswith("Cliente: ")), "")
        registrar_evento_empresa("ligacao", f"ligação de {numero} atendida pela {p['nome']}"
                                 + (f" — assunto: {primeira[:90]}" if primeira else ""),
                                 chatid=numero, funcionaria=p["nome"])
        # painel 📞 Ligações: quem ligou, quem atendeu, duração e assunto
        jrel = _grupo_relatorio("ligacoes")
        if jrel:
            dur = max(1, round((time.time() - t0) / 60))
            await _uaz_post("/send/text", {"number": jrel, "text":
                f"📞 {_hora_sp()} · +{numero} ↔ *{p['nome']}* ({'recebida' if inbound else 'feita'}, ~{dur}min)"
                + (f"\nAssunto: {primeira[:110]}" if primeira else "")})
        corpo = "\n".join(transcript[-40:]).strip()
        nota = (
            "[A pessoa ACABOU de falar com você por LIGAÇÃO de voz"
            + (f" (você estava na pele da {p['nome']})" if emp else "") + ". "
            + ("Foi isto que vocês conversaram na ligação:\n" + corpo
               if corpo else "A ligação acabou de acontecer agora (sem transcrição disponível).")
            + "\nGUARDE como contexto. Quando a pessoa falar aqui no WhatsApp, CONTINUE de onde a ligação parou, "
            "como quem acabou de desligar — não recomece do zero. "
            "AGORA responda com UMA mensagem curta de follow-up pra mandar no WhatsApp da pessoa "
            "(como quem acabou de desligar: 'bom falar contigo!' + resumo em 1-2 linhas do que ficou "
            "combinado/pendente, se houver). Sem markdown pesado, tom de zap.]"
        )
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                OPENCLAW_BIN, "agent", "--agent", "main", "--session-key", "agent:main:wa:" + numero,
                "-m", nota, "--json",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "HOME": "/root"},
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=100)
            # manda o follow-up no WhatsApp da pessoa (blocos <uazapi> + texto que sobrar)
            try:
                d = json.loads(out.decode())
                r = d.get("result", {})
                txt = "\n".join([q.get("text", "") for q in r.get("payloads", []) if q.get("text")]) \
                    or r.get("meta", {}).get("finalAssistantVisibleText", "")
                resto, enviados = await processar_uazapi(numero, txt or "")
                if resto:
                    if await _enviar_bloco_wpp(numero, resto[:900]):
                        enviados += 1
                logging.getLogger("voz").info("follow-up whatsapp pos-ligacao: %d msg(s) enviadas p/ %s",
                                              enviados, numero)
            except Exception as e:
                logging.getLogger("voz").warning("falha no follow-up whatsapp: %s", e)
        except Exception as e:
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            logging.getLogger("voz").warning("falha ao injetar transcricao no openclaw: %r", e)
            # FALLBACK: o cerebro falhou, mas a pessoa NAO pode ficar sem nada no zap.
            try:
                txtfb = (f"Foi ótimo falar contigo agora há pouco! 📞 Aqui é a {p['nome']}, da Empresa.ia. "
                         "Se ficou de eu te mandar algo da ligação, me cobra aqui que eu já resolvo. 🙌")
                ok = await _enviar_bloco_wpp(numero, txtfb)
                logging.getLogger("voz").info("follow-up FALLBACK enviado=%s p/ %s", ok, numero)
            except Exception as e2:
                logging.getLogger("voz").error("ate o fallback do follow-up falhou: %r", e2)

    try:
        ctx.add_shutdown_callback(_ao_desligar)
    except Exception as e:
        # se isto falhar, o follow-up do WhatsApp NUNCA acontece — tem que aparecer no log
        logging.getLogger("voz").error("falha registrando callback de desligar: %s", e)

    background = BackgroundAudioPlayer(
        ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=0.5),
        thinking_sound=[
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.6),
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=0.5),
        ],
    )
    try:
        await background.start(room=ctx.room, agent_session=session)
    except Exception:
        pass

    # (saudacao ja foi disparada la em cima, ANTES dos hooks — inicio sem ar morto)


if __name__ == "__main__":
    # load_threshold alto: a maquina divide 2 vCPUs com o openclaw — com o default (0.7)
    # o worker se marcava "unavailable" em qualquer pico e as ligacoes nao eram atendidas.
    # Checagem de ambiente no boot: faltar algo aqui quebra features EM SILENCIO
    # (sem contexto do zap, sem follow-up, sem cerebro). Nao impede de subir, mas grita no log.
    _boot = logging.getLogger("voz")
    if not (UAZ_SERVER and UAZ_TOKEN):
        _boot.warning("UAZ_SERVER/UAZ_TOKEN ausentes: ligacao NAO tera contexto do WhatsApp nem follow-up")
    if not (os.path.isfile(OPENCLAW_BIN) and os.access(OPENCLAW_BIN, os.X_OK)):
        _boot.warning("OPENCLAW_BIN (%s) nao existe/nao executavel: pedir_para_empresaia e follow-up vao falhar", OPENCLAW_BIN)
    if not (os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")):
        _boot.warning("GOOGLE_API_KEY/GEMINI_API_KEY ausentes: a VOZ (Gemini Realtime) nao vai conectar")

    # shutdown_process_timeout alto: ao desligar, o follow-up de WhatsApp (openclaw) leva
    # ate ~60s; com o default o processo era MORTO antes de conseguir mandar a mensagem.
    agents.cli.run_app(agents.WorkerOptions(
        entrypoint_fnc=entrypoint, load_threshold=0.98, shutdown_process_timeout=150.0))
