#!/usr/bin/env python3
"""Gera os audios de apresentacao (PTT WhatsApp) de cada funcionaria via Gemini TTS,
com a MESMA voz que a ligacao ao vivo usa (coerencia de timbre). Saida: .ogg (opus)."""
import os
import sys
import json
import base64
import subprocess
import urllib.request

API_KEY = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
MODEL = os.environ.get("TTS_MODEL", "gemini-2.5-flash-preview-tts")
OUT_DIR = os.environ.get("OUT_DIR", "/opt/empresa-ia/public")

# (id, voz Gemini, roteiro) — voz IDENTICA a do voz-agente.py (ligacao ao vivo).
VOZES = {
    "sofia":  "Sulafat",
    "bia":    "Laomedeia",
    "clara":  "Kore",
    "maya":   "Achernar",
    "helena": "Gacrux",
    "lara":   "Erinome",
    "nina":   "Leda",
    "alice":  "Autonoe",
    "dani":   "Despina",
}

ROTEIROS = {
    "sofia":  "Oi! Que bom te ver por aqui. Eu sou a Sofia, gerente da sua Empresa ponto i a. Pensa em mim como quem te recebe e te conecta com quem você precisar, tá? Qualquer coisa, é só me chamar que eu te aponto o caminho. Bora?",
    "bia":    "Oii, tudo bem? Aqui é a Bia, cuido das suas redes sociais. Post, comentário, aquela ideia de conteúdo... joga tudo pra mim. Se quiser, já te mostro o que sua audiência andou pedindo. Conta comigo, viu?",
    "clara":  "Oi! Aqui é a Clara, cuido de vendas. Sabe aquele cliente que sumiu, a proposta parada? É comigo. Te ajudo a ver quem tá quentinho pra fechar. Qualquer coisa, me chama que a gente resolve junto.",
    "maya":   "Oi, tudo certo? Sou a Maya, do atendimento. Quando o WhatsApp vira bagunça e tem gente esperando, relaxa que é comigo. Organizo a fila pra você não deixar ninguém no vácuo. Pode contar comigo!",
    "helena": "Olá! Eu sou a Helena, do financeiro. Caixa, contas a receber, aquele atraso chato... deixo tudo claro pra você decidir tranquilo. Quando quiser entender o dinheiro, é só me chamar.",
    "lara":   "Oi! Aqui é a Lara, da operação. Aquele processo que trava, a tarefa que atrasa, o que ninguém viu quebrar... eu acho e arrumo. Se algo emperra seu dia, fala comigo que a gente destrava.",
    "nina":   "Oii! Sou a Nina, cuido da sua rotina. Sabe de manhã, aquela sensação de não saber por onde começar? Eu organizo seu dia e te falo a prioridade. Bora começar bem? É só me chamar.",
    "alice":  "Oi! Eu sou a Alice, do onboarding aqui da Empresa ponto i a. Sou eu que te recebo no comecinho: pego suas informações, entendo seu negócio e deixo tudo configurado do seu jeito. Me conta tudo que a partir daí eu cuido pra sua operação já começar redondinha. Bora?",
    "dani":   "Oi, tudo bem? Aqui é a Dani, do desenvolvimento. Quando precisa integrar, automatizar ou construir alguma coisa técnica, é comigo. Boto a mão na massa e deixo funcionando pra você não se preocupar com a parte difícil. Qualquer coisa técnica, é só me chamar!",
}

# entoacao calorosa/brasileira no proprio prompt (Gemini TTS aceita direcao de estilo).
ESTILO = ("Fale como uma brasileira calorosa, simpatica e proxima, com energia leve e natural, "
          "ritmo de conversa de verdade (nao locucao): ")


def gerar(emp: str, voz: str, texto: str) -> bool:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
    body = {
        "contents": [{"parts": [{"text": ESTILO + texto}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voz}}
            },
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        print(f"[{emp}] ERRO API: {e}")
        return False
    try:
        part = d["candidates"][0]["content"]["parts"][0]
        b64 = part["inlineData"]["data"]
    except Exception:
        print(f"[{emp}] resposta sem audio: {json.dumps(d)[:200]}")
        return False
    pcm = base64.b64decode(b64)
    pcm_path = f"/tmp/aud-{emp}.pcm"
    ogg_path = os.path.join(OUT_DIR, f"audio-{emp}.ogg")
    with open(pcm_path, "wb") as f:
        f.write(pcm)
    # PCM L16 24kHz mono -> ogg/opus (PTT do WhatsApp)
    cmd = ["ffmpeg", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1",
           "-i", pcm_path, "-c:a", "libopus", "-b:a", "32k", ogg_path]
    res = subprocess.run(cmd, capture_output=True)
    os.remove(pcm_path)
    if res.returncode != 0:
        print(f"[{emp}] ffmpeg erro: {res.stderr.decode()[:200]}")
        return False
    sz = os.path.getsize(ogg_path)
    print(f"[{emp}] OK voz={voz} -> {ogg_path} ({sz} bytes)")
    return True


if __name__ == "__main__":
    if not API_KEY:
        print("GOOGLE_API_KEY ausente"); sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    alvos = sys.argv[1:] or list(VOZES.keys())
    ok = 0
    for emp in alvos:
        if emp not in VOZES:
            print(f"[{emp}] desconhecido"); continue
        if gerar(emp, VOZES[emp], ROTEIROS[emp]):
            ok += 1
    print(f"=== {ok}/{len(alvos)} audios gerados ===")
