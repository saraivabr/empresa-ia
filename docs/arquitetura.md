# Arquitetura da Empresa.ia

## Visão geral

A Empresa.ia é composta de três camadas principais:

1. **Gateway** — recebe e envia mensagens no WhatsApp via uazapi
2. **Bridge** — orquestra tudo: transcrição, roteamento, chamadas ao agente, envio rico
3. **Agentes** — OpenClaw (texto) e voz-agente.py (voz)

```
WhatsApp
   │
   │  webhook POST /hook/<WEBHOOK_SECRET>
   │  SSE EventSource (fallback, deduplicado por messageId)
   ▼
uazapi (gateway WhatsApp)
   │
   ▼
bridge.js (Node.js — porta 8090)
   │
   ├─ [mensagem de texto/botão]
   │       └─ spawn openclaw → parse diretivas → uazapi send
   │
   ├─ [áudio PTT]
   │       └─ download → Groq Whisper (ou Gemini) → texto → openclaw
   │
   ├─ [imagem]
   │       └─ download → Gemini Vision → descrição → openclaw
   │
   ├─ [vídeo]
   │       └─ download → ffmpeg (extrai áudio + frame) → Groq + Vision → openclaw
   │
   ├─ [@equipe]
   │       └─ vitrineCarousel() → uazapi send carousel (7 cards)
   │
   ├─ [@resumo]
   │       └─ relatorioCarousel() → uazapi send carousel (por setor)
   │
   └─ [call_employee_<id> / @conectar / lead]
           └─ LiveKit: cria room → dispatch voz-agente.py
```

## bridge.js

Arquivo central do sistema. Responsabilidades:

- **Inbound duplo**: webhook (primário) + SSE (fallback). Deduplicação por `messageId`.
- **Debounce**: agrupa mensagens rápidas do mesmo chat (padrão: 1500ms).
- **Multimodal**: detecta tipo de mensagem e processa antes de chamar o agente.
- **Spawn openclaw**: um processo por sessão ativa. Timeout configurável (`AGENT_TIMEOUT_SEC`).
- **Parse de diretivas**: extrai blocos `<uazapi>{...}</uazapi>` da saída do agente e executa.
- **Envio rico**: texto, PTT (voz), imagem, carrossel, documento, reação.
- **UX "pensando"**: edita uma mensagem mostrando o que está fazendo (`THINK_DELAY_MS`).
- **Health**: servidor HTTP em `HEALTH_PORT` com endpoint `/health` e stats.
- **Usage tracking**: salva histórico de uso por contato em JSON (`EMPRESAIA_USAGE_FILE`).
- **Leads**: processa diretiva `lead` e salva em `LEADS_FILE`.

## OpenClaw (agente)

Binário externo que recebe contexto (system prompt + histórico) via stdin/stdout. Não faz parte deste repositório — é instalado separadamente.

- System prompt: `SOUL-empresaia-full.md` (configurado no workspace openclaw)
- Sessão por contato: cada `chatid` tem seu próprio processo com histórico
- Suporta múltiplos modelos: Claude Sonnet (padrão), GPT-4o, Gemini, etc.

## voz-agente.py

Agente LiveKit que roda como worker e processa ligações por voz.

- **Personas**: 9 personas (PERSONAS dict). Cada uma tem voz Gemini, sotaque e jeito únicos.
- **Resolução de persona**: lê `employee_id` do metadata da room LiveKit. Fallback pelo nome da room (`call-<persona>-<rand>`).
- **Contexto da ligação**: busca histórico do contato no uazapi antes de atender. A persona já sabe com quem está falando.
- **Ferramenta `pedir_para_empresaia`**: durante a call, chama o bridge via HTTP para buscar dados reais ou enviar algo no WhatsApp do contato em tempo real.
- **Preenchimento de silêncio**: ESTILO_CASA define regras rígidas de ritmo: frases curtas, bate-bola, nunca silêncio.

## Fluxo de voz (ligação de saída)

```
bridge.js detecta ação de call
    │
    ▼
LiveKit API: cria room "call-<persona>-<uuid>"
    │
    ▼
LiveKit SIP: dispatch call para número WhatsApp via tronco SIP
    │
    ▼
voz-agente.py (worker) recebe job
    │
    ├─ resolve_persona() → lê employee_id do metadata
    ├─ busca contexto do contato (histórico uazapi)
    ├─ Gemini native-audio: conversa ao vivo, latência baixa
    │
    └─ pedir_para_empresaia (function_tool)
           └─ POST /hook/<secret>?tool=1 no bridge
                  └─ bridge roda openclaw → resposta + ação no WA

WhatsApp do contato recebe mensagens/links durante a ligação
```

## Geração de assets

- `gen-audios.py` — gera áudios `.ogg` (PTT) com Gemini TTS. Mesma voz da ligação ao vivo.
- `gen-app-cards.js` — gera imagens JPEG dos cards de carrossel.
- `gen-group-icon.js` — gera ícone para grupos WhatsApp criados pela Empresa.ia.

Assets são servidos de `PUBLIC_DIR` via `ASSET_BASE` (nginx ou equivalente).

## Infraestrutura de voz (voz-infra/)

Docker Compose com três serviços:

- **redis**: estado interno do LiveKit
- **livekit**: servidor WebRTC/SIP (livekit/livekit-server)
- **sip**: serviço SIP do LiveKit para chamadas WhatsApp via tronco

Configurações: `livekit.yaml` e `sip.yaml` (montados como volumes).
