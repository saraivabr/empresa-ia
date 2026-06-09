import os
import json
import asyncio
import re
import random
from livekit import agents
from livekit.agents import Agent, AgentSession, function_tool, RunContext
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
  • É o DONO do negócio: parceria direta, de braço dado. Ele é o chefe. Sem bajulação, sem infantilizar.
    Vai direto ao ponto que importa pra ele, fala de igual pra igual.
  • É um CLIENTE já conhecido: acolhe pelo nome, lembra do que rolou, tom profissional e próximo, resolve.
  • É um LEAD/possível cliente: simpática e consultiva, entende a dor e conduz pro próximo passo, sem empurrar.
  • Não sabe quem é: descobre cedo, com leveza ("com quem eu falo?"), e adapta na hora.
- O assunto e o tom mudam conforme a pessoa. Não fale igual pra todo mundo — leia a sala.

COMO VOCÊ TRATA A PESSOA (regra inviolável):
- Trate SEMPRE pelo NOME (veja o CONTEXTO da ligação). Se não souber o nome, pergunte cedo, com leveza.
- NUNCA presuma gênero. JAMAIS use "menina", "amiga", "mana", "querida", "linda", "moça" — nada disso.
  Termos neutros e pelo nome da pessoa, "cara", "e aí", "beleza". Na dúvida, só o nome.

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
    "lia":    {"voice": "Aoede",     "nome": "Lia",    "setor": "assistente pessoal do dono",
               "sotaque": "paulistana", "jeito": "braço direito do dono, próxima e resolvedora"},
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
}
DEFAULT_PERSONA = "lia"


def persona_instructions(p: dict) -> str:
    return (
        f"Você é a {p['nome']}, da área de {p['setor']}, da equipe da Empresa.ia. "
        f"Seu jeito: {p['jeito']}. Fale com sotaque {p['sotaque']}, do seu jeito próprio e consistente "
        f"do começo ao fim da ligação. Apresente-se pelo nome logo no início.\n\n" + ESTILO_CASA
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
        partes.append("Na linha está o DONO/fundador da Empresa.ia — seu chefe e parceiro. "
                      "Trate com respeito e proximidade de quem fala com o fundador. "
                      "JAMAIS use 'menina', 'amiga', 'mana', 'querida' — isso é erro grave.")
    elif nome:
        partes.append(f"Quem está na linha: {nome} (WhatsApp {numero}). Trate pelo nome, sem presumir gênero.")
    else:
        partes.append(f"Número na linha: {numero}. Pergunte o nome com leveza e trate por ele; não presuma gênero.")
    if historico:
        partes.append("Conversa recente no WhatsApp (a mais nova embaixo):\n" + "\n".join(historico[-10:]))
    return "\n".join(partes)


async def _uaz_post(path: str, payload: dict, total: int = 15) -> bool:
    """POST simples no uazapi (envio durante a ligacao). Falha silenciosa."""
    if not (UAZ_SERVER and UAZ_TOKEN):
        return False
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=total)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(f"{UAZ_SERVER}{path}",
                              headers={"token": UAZ_TOKEN, "Content-Type": "application/json"},
                              json=payload) as r:
                return 200 <= r.status < 300
    except Exception:
        return False


async def _enviar_bloco_wpp(numero: str, obj) -> None:
    """Manda um bloco (texto ou dict normalizado openclaw) pro WhatsApp de quem esta na linha."""
    if isinstance(obj, str):
        t = re.sub(r"[*_`#>]", "", obj).strip()
        if t:
            await _uaz_post("/send/text", {"number": numero, "text": t})
        return
    if not isinstance(obj, dict):
        return
    tp = str(obj.get("type") or "").lower()
    url = obj.get("url") or obj.get("file")
    if tp in ("ptt", "voice", "send.ptt"):
        if url:
            await _uaz_post("/send/media", {"number": numero, "type": "ptt", "file": url}, total=90)
    elif tp in ("audio", "send.audio"):
        if url:
            await _uaz_post("/send/media", {"number": numero, "type": "audio", "file": url}, total=90)
    elif tp in ("image", "video", "document", "media", "send.media"):
        if url:
            await _uaz_post("/send/media", {"number": numero,
                                            "type": obj.get("mediatype") or ("image" if tp in ("media", "send.media") else tp),
                                            "file": url, "text": obj.get("caption") or obj.get("text") or ""}, total=90)
    elif tp == "carousel" or isinstance(obj.get("carousel"), list):
        await _uaz_post("/send/carousel", {**obj, "number": numero}, total=90)
    elif tp in ("button", "buttons", "list", "poll"):
        p = {**obj, "number": numero}
        if tp == "buttons":
            p["type"] = "button"
        await _uaz_post("/send/menu", p, total=90)
    elif obj.get("text"):
        await _uaz_post("/send/text", {"number": numero, "text": str(obj["text"]).strip()})


async def processar_uazapi(numero: str, raw: str) -> str:
    """Extrai os blocos <uazapi> da resposta do openclaw, ENVIA cada um pro WhatsApp de
    quem esta na linha (ao vivo, durante a ligacao) e devolve o texto limpo pra ser FALADO."""
    if not raw:
        return ""
    txt = re.sub(r"<uazapi-action>[\s\S]*?</uazapi-action>", "", raw)
    blocos = re.findall(r"<uazapi>([\s\S]*?)</uazapi>", txt)
    if numero and blocos:
        for b in blocos:
            try:
                obj = json.loads(b.strip())
            except Exception:
                obj = b.strip()
            try:
                await _enviar_bloco_wpp(numero, obj)
            except Exception:
                pass
    falado = re.sub(r"<uazapi>[\s\S]*?</uazapi>", "", txt)
    falado = re.sub(r"\[\[[a-z_]+\]\]", "", falado, flags=re.I)
    falado = re.sub(r"[*_`#>]", "", falado).strip()
    return falado


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
    try:
        proc = await asyncio.create_subprocess_exec(
            OPENCLAW_BIN, "agent", "--agent", "main", "--session-key", sk,
            "-m", prompt, "--json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "HOME": "/root"},
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=45)
        d = json.loads(out.decode())
        r = d.get("result", {})
        txt = "\n".join([p.get("text", "") for p in r.get("payloads", []) if p.get("text")]) \
            or r.get("meta", {}).get("finalAssistantVisibleText", "")
        # ENVIA o que for <uazapi> pro WhatsApp do caller (ao vivo) e devolve so o texto falado.
        falado = await processar_uazapi(numero, txt or "")
        return falado[:600] or "Pronto, ó — já te mandei aqui no WhatsApp também, dá uma olhada."
    except Exception:
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
    def __init__(self, instructions: str, employee_id: str = "", numero: str = ""):
        super().__init__(instructions=instructions)
        self._employee_id = employee_id
        self._numero = numero

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
        except Exception:
            pass
        return await chamar_openclaw(tarefa, self._employee_id, self._numero)


def _envbool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on", "sim")


def build_llm(voice: str):
    # Voz humana de verdade: modelo NATIVE-AUDIO + dialogo afetivo + proatividade.
    # O 1008 antigo era nome de modelo/versao errados; com o nome certo o plugin
    # liga v1alpha sozinho quando affective/proactivity estao on. Modelos validados:
    #   gemini-2.5-flash-native-audio-preview-12-2025  (mais expressivo)
    #   gemini-2.5-flash-native-audio-preview-09-2025
    # Sem GEMINI_LIVE_MODEL -> cai no default do plugin (half-cascade, fala 1o, seguro).
    model = os.environ.get("GEMINI_LIVE_MODEL", "").strip()
    kwargs = dict(voice=voice, temperature=0.9, language="pt-BR")
    if model:
        kwargs["model"] = model
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

    emp = resolve_persona(ctx)
    p = PERSONAS[emp]

    # Quem esta na linha? Espera o participante SIP para ler o numero e ja puxar o contexto.
    participant = None
    try:
        participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=15)
    except Exception:
        participant = None
    numero = numero_do_caller(ctx, participant)
    contexto = ""
    try:
        contexto = await carregar_contexto_whatsapp(numero) if numero else ""
    except Exception:
        contexto = ""

    instr = persona_instructions(p)
    if contexto:
        instr += (
            "\n\nCONTEXTO DESTA LIGACAO (voce JA SABE disso — use de forma natural, mostre que reconhece "
            "a pessoa e lembra do que falaram, sem recitar tudo de forma mecanica):\n" + contexto
        )

    session = AgentSession(
        llm=build_llm(p["voice"]),
        preemptive_generation=True,      # comeca a responder antes de o usuario terminar -> menos latencia
        min_endpointing_delay=0.4,       # responde rapido depois que a pessoa para de falar
        resume_false_interruption=True,  # som ambiente nao corta a fala dela por engano
        false_interruption_timeout=1.0,
    )
    await session.start(agent=EmpresaVoz(instr, emp, numero), room=ctx.room)

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

    for _ev in ("conversation_item_added", "conversation_item"):
        try:
            session.on(_ev, _on_item)
        except Exception:
            pass

    async def _ao_desligar():
        # injeta o que rolou na ligacao na MESMA sessao do WhatsApp -> a conversa continua no zap
        if not numero:
            return
        corpo = "\n".join(transcript[-40:]).strip()
        nota = (
            "[A pessoa ACABOU de falar com você por LIGAÇÃO de voz"
            + (f" (você estava na pele da {p['nome']})" if emp else "") + ". "
            + ("Foi isto que vocês conversaram na ligação:\n" + corpo
               if corpo else "A ligação acabou de acontecer agora (sem transcrição disponível).")
            + "\nGUARDE como contexto. Quando a pessoa falar aqui no WhatsApp, CONTINUE de onde a ligação parou, "
            "como quem acabou de desligar — não recomece do zero. Não responda nada agora.]"
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                OPENCLAW_BIN, "agent", "--agent", "main", "--session-key", "agent:main:wa:" + numero,
                "-m", nota, "--json",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "HOME": "/root"},
            )
            await asyncio.wait_for(proc.communicate(), timeout=40)
        except Exception:
            pass

    try:
        ctx.add_shutdown_callback(_ao_desligar)
    except Exception:
        pass

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
            confirma="confirme pelo NOME quem está na linha, veja o CONTEXTO — ex: 'é o [nome]?'")
    else:
        saudacao = abre_natural.format(
            nome=p["nome"], sotaque=p["sotaque"],
            confirma="descubra com quem fala — 'com quem eu falo?'")
    await session.generate_reply(instructions=saudacao)


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
