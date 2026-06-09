# Empresa.ia

**Versão:** 1.0.0 | **Porta:** 8090 (health) | **Stack:** Node.js 18+ / Python 3.11+ / LiveKit / uazapi

## O que é

Sistema operacional que vive dentro do WhatsApp. Um time de funcionárias de IA (personas brasileiras) que tocam a operação de um negócio direto no WhatsApp do dono — com voz natural, multimodal e integrações Google. O cliente fala com a **Sofia** (anfitriã), que traz a especialista certa.

## Quick Start

```bash
./setup.sh                          # Primeira vez: instala deps, cria .env
cp instances.json.example instances.json   # Configurar instância uazapi
node bridge.js                      # Iniciar bridge principal
python3 voz-agente.py start         # Iniciar agente de voz (terminal separado)
npm test                            # Rodar testes
```

## Comandos

```bash
# Dependências
npm install                         # Instalar deps Node.js
python3 -m venv venv && pip install livekit-agents livekit-plugins-google

# Desenvolvimento
node bridge.js                      # Bridge principal (webhook :8090)
python3 voz-agente.py start         # Agente de voz LiveKit

# Produção (PM2)
pm2 start ecosystem.local.config.cjs
pm2 logs empresa-ia-bridge
curl http://localhost:8090/health   # Health check

# Geração de assets
python3 gen-audios.py               # Gera áudios PTT de cada funcionária (Gemini TTS)
node gen-app-cards.js               # Gera cards de carrossel
node gen-group-icon.js              # Gera ícone de grupo

# Testes
npm test                            # node --test (16 testes)

# Infraestrutura de voz
cd voz-infra && docker compose up -d  # LiveKit + SIP + Redis
```

## Arquitetura

```
WhatsApp (usuário)
    │
uazapi (gateway)          webhook POST /hook/<secret>  |  SSE fallback
    │
bridge.js (Node)          orquestra tudo: debounce, dedup, transcrição, roteamento
    ├── OpenClaw           agente (cérebro) — sessão por contato, modelo configurável
    │       └── SOUL-empresaia-full.md   system prompt da Sofia
    ├── LiveKit + voz-agente.py          ligação por voz (Gemini native-audio)
    │       └── pedir_para_empresaia     envia no WA durante a call
    ├── Groq Whisper       transcrição de áudio
    ├── Gemini Vision      descrição de imagem/vídeo
    └── Composio           integrações Gmail, Agenda, Sheets, Drive
```

**Fluxo de mensagem:** uazapi → bridge.js recebe → debounce 1.5s → se áudio/vídeo transcribe → spawn openclaw → parse diretivas `<uazapi>` → envia resposta rica (texto, PTT, carrossel, imagem).

**Fluxo de voz:** bridge.js detecta `call_employee_<id>` → LiveKit cria room → dispatch voz-agente.py → persona resolve pelo metadata da room → Gemini native-audio ao vivo → `pedir_para_empresaia` chama bridge via HTTP para enviar no WA durante a call.

## Arquivos-chave

```
bridge.js              Orquestrador principal. Webhook + SSE + debounce + transcrição + envio rico.
voz-agente.py          Agente de voz. 9 personas (PERSONAS dict), resolve_persona(), ESTILO_CASA.
SOUL-empresaia-full.md System prompt completo da Sofia. A "alma" do agente.
soul-empresaia.md      Versão condensada do SOUL (comportamento pull/conversa).
FLUXO-EXPERIENCIA.md   Fonte da verdade: fluxo, personas, roteiros, carrosséis, status de impl.
gen-audios.py          Gera áudios .ogg de apresentação via Gemini TTS (mesma voz da ligação).
ecosystem.config.cjs   Config PM2. Copie para ecosystem.local.config.cjs e edite.
instances.json.example Exemplo de instâncias uazapi (id, token, number, agent_id).
.env.example           Todas as vars de ambiente comentadas (source of truth de config).
voz-infra/             docker-compose.yml, livekit.yaml, sip.yaml para infraestrutura de voz.
test/empresaia.test.js Testes Node.js (node:test). Roda com: npm test.
```

## Configuração

Todas as configurações são via variáveis de ambiente. Copie `.env.example` e preencha:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `UAZ_SERVER` | Sim | URL do seu servidor uazapi |
| `UAZ_TOKEN` | Sim | Token da instância uazapi |
| `UAZ_ADMIN_TOKEN` | Sim | Token admin uazapi |
| `OPENCLAW_BIN` | Sim | Path do binário openclaw |
| `OWNER_NUMBERS` | Sim | Seu número WhatsApp (só dígitos, sem +) |
| `WEBHOOK_SECRET` | Sim | Segredo do path do webhook (openssl rand -hex 20) |
| `GROQ_API_KEY` | Sim | Transcrição Whisper |
| `GOOGLE_API_KEY` | Sim | Gemini Vision + TTS |
| `LIVEKIT_URL` | Voz | URL do servidor LiveKit |
| `LIVEKIT_API_KEY` | Voz | Chave LiveKit |
| `LIVEKIT_API_SECRET` | Voz | Secret LiveKit |
| `COMPOSIO_API_KEY` | Integrações | Chave Composio |
| `ASSET_BASE` | Sim | URL pública dos assets (carrosséis, áudios) |

## Personas

9 personas definidas em `voz-agente.py` (PERSONAS dict). Cada uma tem: `voice` (timbre Gemini), `nome`, `setor`, `sotaque`, `jeito`. A mesma voz Gemini usada em `gen-audios.py` para coerência de timbre entre PTT e ligação ao vivo.

Personas: `lia`, `sofia`, `clara`, `bia`, `maya`, `helena`, `lara`, `nina`, `alice`, `dani`.

## Convenções

- Diretivas do agente: `<uazapi>{"type":"text","body":"..."}` — bridge.js parseia e executa.
- Instâncias em `instances.json` (não commitado). Formato em `instances.json.example`.
- Assets gerados em `/opt/empresa-ia/public/` (não commitado). `ASSET_BASE` aponta para lá.
- Dados de runtime (leads, usage, grupos) em `/opt/empresa-ia/*.json` (não commitados).

## Contributing

Veja [CONTRIBUTING.md](CONTRIBUTING.md).
