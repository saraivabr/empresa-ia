# Empresa.ia

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-uazapi-25D366.svg)](https://uazapi.com/)
[![Open Source](https://img.shields.io/badge/open--source-gratuito-brightgreen.svg)](#)

> **O sistema operacional que vive dentro do WhatsApp.**

Não é chatbot. Não é menu de opções. É um **time de funcionárias de IA** que toca a operação do seu negócio direto no WhatsApp — com voz, personalidade e contexto real.

---

## O que é a Empresa.ia

Imagine ter uma equipe completa que:

- **Atende** seu WhatsApp e responde como uma pessoa real, de nome, sem nunca dizer "sou um robô"
- **Liga** pra seus clientes com voz natural e latência baixa — e, durante a ligação, já manda links e carrosséis no WhatsApp deles
- **Entende** áudio (transcrição), imagem e vídeo que você mandar
- **Conecta** com Gmail, Google Agenda, Sheets e Drive
- **Qualifica leads**, salva no CRM e aciona a especialista certa automaticamente

Tudo isso no WhatsApp. Sem app novo. Sem onboarding complicado. Só manda um **"oi"**.

---

## A Equipe

Quem trabalha pra você:

| Nome | Setor | O que faz |
|------|-------|-----------|
| **Sofia** | Gerência | Anfitriã — recebe, entende e conecta com a especialista certa |
| **Bia** | Redes Sociais | Posts, comentários, pauta de conteúdo |
| **Clara** | Vendas | Leads, propostas paradas, fechamento |
| **Maya** | Atendimento | Fila do WhatsApp, quem ficou sem resposta |
| **Helena** | Financeiro | Caixa, atrasos, cobranças |
| **Lara** | Operação | Processos, tarefas, o que trava o dia |
| **Nina** | Rotina | Agenda, prioridade da manhã |
| **Alice** | Onboarding | Recebe, configura, personaliza |
| **Dani** | Desenvolvimento | Integrações e automações técnicas |

Cada uma tem voz própria (Gemini TTS), áudio de apresentação, e uma personalidade consistente — tanto no WhatsApp quanto nas ligações.

---

## Capacidades ("apps do sistema")

### Conversa humana no WhatsApp
O cérebro é o **OpenClaw** (agente), com sessão por contato. A Sofia recebe, entende o contexto e traz a especialista certa — sem menu, sem robô, sem script engessado.

### Ligação por voz
A IA **liga** pra pessoa. Voz natural com baixa latência via **LiveKit + Gemini native-audio**. O diferencial: durante a ligação, ela envia mensagens, links e carrosséis no WhatsApp do cliente ao vivo (ferramenta `pedir_para_empresaia`). Inclui uma "ligação de descoberta" no onboarding.

### Multimodal
- **Áudio**: transcrição via Groq Whisper (fallback: Gemini)
- **Imagem**: descrição via Gemini Vision
- **Vídeo**: extrai áudio (ffmpeg) + frame (Vision) e entende o que foi mandado

### Integrações (`@conectar`)
Gmail, Google Agenda, Google Sheets e Drive via Composio/OpenClaw. A Sofia conecta na hora, sem sair do WhatsApp.

### Grupos dedicados
Cria grupo no WhatsApp, adiciona o dono como admin, nomeia, põe ícone e atende direto ali.

### Mini-CRM de leads
Captura dados de qualificação durante a conversa e salva estruturado. Sofia descobre sem interrogatório — uma coisa por vez, encaixada no papo.

### UX de "pensando"
Edita uma mensagem ao vivo mostrando o que está fazendo (`"puxando seus leads..."`, `"verificando o caixa..."`). Só ativa em tarefas reais, não em resposta simples.

### Comandos rápidos
- `@equipe` — carrossel com as 7 funcionárias + botão "Falar com a X"
- `@resumo` — relatório diário por setor
- `@conectar` — abre o fluxo de integrações

---

## Arquitetura

```
                    ┌──────────────────────────────────────────┐
                    │              WhatsApp (usuário)           │
                    └──────────────┬───────────────────────────┘
                                   │ mensagem / áudio / imagem / vídeo
                    ┌──────────────▼───────────────────────────┐
                    │          uazapi (gateway WA)              │
                    │  webhook POST /hook/<secret>              │
                    │  SSE fallback (deduplicação por msgId)    │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │           bridge.js (Node.js)             │
                    │  • debounce + deduplicação                │
                    │  • transcrição (Groq Whisper / Gemini)    │
                    │  • visão (Gemini Vision)                  │
                    │  • roteamento para voz / carrossel / CRM  │
                    │  • health check :8090                     │
                    └──────────┬────────────┬──────────────────┘
                               │            │
              ┌────────────────▼──┐    ┌────▼──────────────────────┐
              │   OpenClaw (agente)│    │    LiveKit (voz)           │
              │   cérebro da Sofia │    │  voz-agente.py             │
              │   sessão/contato   │    │  Gemini native-audio       │
              │   Claude Sonnet    │    │  SIP trunk (WAVOIP)        │
              └───────────────────┘    │  pedir_para_empresaia →    │
                                       │  envia no WA durante call  │
                                       └────────────────────────────┘
```

---

## Pré-requisitos

Você vai precisar de contas em:

| Serviço | Uso | Link |
|---------|-----|------|
| **uazapi** | Gateway WhatsApp (webhook + SSE) | [uazapi.com](https://uazapi.com) |
| **OpenClaw** | Agente de IA (cérebro) | instalado no servidor |
| **Groq** | Transcrição de áudio (Whisper) | [console.groq.com](https://console.groq.com) |
| **Google / Gemini** | Visão, TTS, áudio live | [aistudio.google.com](https://aistudio.google.com) |
| **LiveKit** | Infraestrutura de voz WebRTC/SIP | [livekit.io](https://livekit.io) |
| **Composio** | Integrações Gmail, Agenda, Sheets | [composio.dev](https://composio.dev) |
| **WAVOIP** *(opcional)* | Ligações pelo número do WhatsApp | [wavoip.com](https://wavoip.com) |

Runtime:
- **Node.js 18+** e npm
- **Python 3.11+** e pip
- **ffmpeg** (transcrição de vídeo/áudio)
- **PM2** (processo em produção)
- **Docker + Docker Compose** (infraestrutura LiveKit)

---

## Instalação rápida

```bash
git clone https://github.com/seu-usuario/empresa-ia-oss.git
cd empresa-ia-oss
./setup.sh
```

O script valida o ambiente, instala dependências e cria o `.env` com instruções.

---

## Configuração passo a passo

### 1. Variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` com suas chaves. Variáveis essenciais:

```bash
# Gateway WhatsApp
UAZ_SERVER=https://SEU-SUBDOMINIO.uazapi.com
UAZ_TOKEN=seu-token-uazapi
UAZ_ADMIN_TOKEN=seu-admin-token

# Agente
OPENCLAW_BIN=/usr/bin/openclaw
OWNER_NUMBERS=55119XXXXXXXX   # seu número (dono), só dígitos
WEBHOOK_SECRET=               # gere com: openssl rand -hex 20

# Transcricao e visao
GROQ_API_KEY=gsk_...
GOOGLE_API_KEY=...
GEMINI_API_KEY=...

# Voz
LIVEKIT_URL=wss://seu-livekit:7880
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Veja `.env.example` para a lista completa com comentários.

### 2. Instâncias WhatsApp

```bash
cp instances.json.example instances.json
# Edite instances.json com seu token e número uazapi
```

### 3. Assets da equipe

Gere os áudios de apresentação de cada funcionária:

```bash
export GOOGLE_API_KEY=sua-chave
python3 gen-audios.py
# Saída em /opt/empresa-ia/public/
```

Gere os cards do carrossel:

```bash
node gen-app-cards.js
```

### 4. Configurar o uazapi

No painel uazapi, configure o webhook da instância apontando para:

```
POST https://seu-servidor.com/hook/<WEBHOOK_SECRET>
```

### 5. Infraestrutura de voz (LiveKit)

```bash
cd voz-infra
# Copie e edite os arquivos de configuração
cp livekit.yaml /opt/livekit/livekit.yaml
cp sip.yaml /opt/livekit/sip.yaml
docker compose up -d
```

### 6. Instalar dependências Python (agente de voz)

```bash
python3 -m venv /opt/empresa-ia/venv
/opt/empresa-ia/venv/bin/pip install livekit-agents livekit-plugins-google
```

---

## Como rodar

### Desenvolvimento

```bash
node bridge.js              # bridge principal
python3 voz-agente.py start # agente de voz (em outro terminal)
```

### Produção com PM2

```bash
cp ecosystem.config.cjs ecosystem.local.config.cjs
# Edite ecosystem.local.config.cjs com seus caminhos
pm2 start ecosystem.local.config.cjs
pm2 save
pm2 startup
```

O agente de voz roda com o script dedicado:

```bash
/opt/empresa-ia/voz-infra/run.sh
# Ou via systemd / pm2 — veja a documentação em docs/voz.md
```

### Verificar saúde

```bash
curl http://localhost:8090/health
```

---

## Testes

```bash
npm test
```

16 testes cobrindo: roteamento de mensagens, carrosséis, usage tracking, health check, comandos `@equipe` e `@resumo`.

---

## Estrutura do projeto

```
empresa-ia-oss/
├── bridge.js              # Gateway principal: webhook + SSE + agente + envio rico
├── voz-agente.py          # Agente de voz LiveKit (Gemini native-audio, 9 personas)
├── voz-bridge.py          # Bridge de contexto para ElevenLabs (opcional)
├── gen-audios.py          # Gera áudios PTT de apresentação (Gemini TTS)
├── gen-app-cards.js       # Gera cards de carrossel da equipe
├── gen-group-icon.js      # Gera ícone de grupo WhatsApp
├── autocalls-tool-new.js  # Ferramenta de chamadas automáticas
├── SOUL-empresaia-full.md # System prompt completo da Sofia (alma do agente)
├── soul-empresaia.md      # System prompt condensado (comportamento pull)
├── FLUXO-EXPERIENCIA.md   # Fonte da verdade: fluxo, roteiros, personas
├── ecosystem.config.cjs   # Config PM2 (copie para .local. e edite)
├── instances.json.example # Exemplo de config de instâncias uazapi
├── .env.example           # Todas as variáveis de ambiente comentadas
├── voz-infra/             # Docker Compose + configs LiveKit + SIP
├── docs/                  # Documentação HTML (usuário final + técnico)
└── test/                  # Testes Node.js (node:test)
```

---

## Usando com Claude Code

Este projeto inclui um `CLAUDE.md` com contexto completo da arquitetura, comandos e convenções.

```bash
claude    # Inicia o Claude Code — lê CLAUDE.md automaticamente
```

---

## Documentação

- `docs/index.html` — Guia do usuário final (como usar no dia a dia)
- `docs/tecnico.html` — Referência técnica (endpoints, diretivas, deploy)
- `docs/arquitetura.md` — Arquitetura detalhada
- `docs/voz.md` — Infraestrutura de voz e ligações
- `docs/multimodal.md` — Transcrição de áudio, visão e vídeo
- `docs/integracoes.md` — Gmail, Agenda, Sheets via Composio
- `docs/personas.md` — As personas, vozes e roteiros

---

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para como contribuir.

---

## Licença

MIT — veja [LICENSE](LICENSE). Gratuito para todos.

---

*Empresa.ia — porque atendimento virou commodity. O jogo agora é a experiência.*
