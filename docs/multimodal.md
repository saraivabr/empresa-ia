# Multimodal — Áudio, Imagem e Vídeo

A Empresa.ia entende mais do que texto. Quando o contato manda um áudio, foto ou vídeo, o bridge processa e converte para texto antes de passar para o agente — que responde como se tivesse visto/ouvido tudo.

## Transcrição de áudio (PTT e arquivo de áudio)

### Fluxo

```
Contato manda áudio (PTT ou arquivo)
    │
    ▼
bridge.js baixa o arquivo via uazapi
    │
    ├─ Groq Whisper (primário, mais rápido)
    │       POST https://api.groq.com/openai/v1/audio/transcriptions
    │       modelo: whisper-large-v3-turbo
    │
    └─ Gemini (fallback, se Groq falhar)
            POST generativelanguage.googleapis.com
            modelo: GEMINI_TRANSCRIBE_MODEL (padrão: gemini-2.5-flash)

Texto transcrito é injetado no contexto do agente:
"[áudio recebido: '<transcrição>']"
```

### Configuração

```bash
GROQ_API_KEY=gsk_...           # Primário (Whisper)
GOOGLE_API_KEY=...             # Fallback Gemini
ENABLE_AUDIO_TRANSCRIPTION=1   # 0 para desabilitar
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash
```

## Visão (imagens)

### Fluxo

```
Contato manda imagem
    │
    ▼
bridge.js baixa via uazapi
    │
    ▼
Gemini Vision: descreve a imagem em português
    │
    ▼
Descrição injetada no contexto:
"[imagem recebida: '<descrição detalhada>']"
```

O agente responde ao conteúdo da imagem como se tivesse visto. Exemplos: nota fiscal, captura de tela de CRM, foto de produto, print de conversa.

## Vídeo

### Fluxo

```
Contato manda vídeo
    │
    ▼
bridge.js baixa via uazapi
    │
    ├─ ffmpeg extrai áudio → Groq Whisper (transcrição)
    └─ ffmpeg extrai frame central → Gemini Vision (descrição visual)
    │
    ▼
Contexto combinado injetado no agente:
"[vídeo recebido — áudio: '<transcrição>' | visual: '<descrição>']"
```

**Requisito:** `ffmpeg` instalado no servidor. Sem ele, vídeos são ignorados e o agente é avisado.

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

## Contexto para o agente

O bridge sempre avisa o agente sobre o tipo de mídia recebida. Mesmo que a transcrição ou visão falhe, o agente sabe que recebeu um áudio/imagem/vídeo e pode pedir para mandar de novo ou perguntar o que era.

Formatos reconhecidos:
- **Áudio**: PTT (ogg/opus), mp3, mp4 (só áudio), wav, m4a
- **Imagem**: jpg, jpeg, png, webp, gif
- **Vídeo**: mp4, mov, avi
