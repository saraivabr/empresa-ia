# Voz — Ligações pelo WhatsApp

## Como funciona

A Empresa.ia pode **ligar** para o contato diretamente pelo WhatsApp. A ligação usa voz natural com baixa latência (Gemini native-audio) e tem um superpoder: durante a ligação, a IA envia mensagens, links e carrosséis no WhatsApp do contato em tempo real.

## Componentes

| Componente | Função |
|------------|--------|
| LiveKit | Infraestrutura WebRTC/SIP (room, dispatch, mídia) |
| voz-agente.py | Worker Python com as personas |
| Gemini Live Audio | Modelo de voz nativo (baixa latência, expressivo) |
| Tronco SIP | Saída para números WhatsApp (WAVOIP ou outro) |
| pedir_para_empresaia | Function tool: ação no WA durante a call |

## Configuração rápida

### 1. Subir a infraestrutura LiveKit

```bash
cd voz-infra

# Edite os arquivos de configuração
cp livekit.yaml /opt/livekit/livekit.yaml    # edite com suas chaves
cp sip.yaml /opt/livekit/sip.yaml            # edite com suas chaves

docker compose up -d
```

### 2. Criar tronco SIP no LiveKit Cloud

No painel [LiveKit Cloud](https://cloud.livekit.io) ou via CLI:

```bash
lk sip outbound create \
  --name "whatsapp-trunk" \
  --address "sip.wavoip.com" \
  --username "seu-usuario-wavoip" \
  --password "sua-senha-wavoip"
```

Copie o `SIP_TRUNK_ID` gerado e coloque no `.env`:
```bash
VOZ_SIP_TRUNK=ST_seu_trunk_id
```

### 3. Instalar dependências Python

```bash
python3 -m venv /opt/empresa-ia/venv
/opt/empresa-ia/venv/bin/pip install \
  livekit-agents \
  livekit-plugins-google
```

### 4. Iniciar o agente de voz

```bash
# Desenvolvimento
python3 voz-agente.py start

# Produção (via script dedicado)
/opt/empresa-ia/voz-infra/run.sh

# Ou via systemd (recomendado em produção)
# Crie /etc/systemd/system/empresaia-voz.service
```

Exemplo de unit systemd:

```ini
[Unit]
Description=Empresa.ia Voice Agent
After=network.target

[Service]
EnvironmentFile=/opt/empresa-ia/.env
WorkingDirectory=/opt/empresa-ia
ExecStart=/opt/empresa-ia/venv/bin/python /opt/empresa-ia/voz-agente.py start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Modos de chamada

O `.env` suporta dois modos via `VOZ_CALL_MODE`:

### livekit (padrão)
Usa LiveKit + tronco SIP. Requer `LIVEKIT_*` e `VOZ_SIP_TRUNK` configurados.

```bash
VOZ_CALL_MODE=livekit
```

### autocalls (alternativo)
Usa o provider Autocalls. Requer `AUTOCALLS_*` configurados.

```bash
VOZ_CALL_MODE=autocalls
AUTOCALLS_BASE_URL=https://api.autocalls.ai
AUTOCALLS_API_KEY=seu-key
AUTOCALLS_ASSISTANT_ID=seu-assistant-id
```

### WAVOIP (tronco SIP alternativo)
Para ligar por números WhatsApp via WAVOIP como tronco SIP do LiveKit:

```bash
WAVOIP_BASE_URL=https://api.wavoip.com
WAVOIP_API_KEY=seu-key
WAVOIP_DEVICE_TOKEN=seu-device-token
```

## Personas

Cada ligação usa uma persona específica. A persona é passada no metadata da room LiveKit:

```json
{ "employee_id": "clara" }
```

Personas disponíveis: `lia`, `sofia`, `clara`, `bia`, `maya`, `helena`, `lara`, `nina`, `alice`, `dani`.

Cada persona tem uma voz Gemini exclusiva, sotaque e jeito de falar. Ver lista completa em `docs/personas.md`.

## A ferramenta pedir_para_empresaia

Durante a ligação, o agente de voz pode chamar o bridge para:
- Buscar dados reais (leads, caixa, agenda, Instagram)
- Gerar conteúdo (arte, texto, relatório)
- Enviar algo no WhatsApp do contato (link, carrossel, documento)

O contato **recebe no WhatsApp** enquanto ainda está na ligação. O agente avisa na fala:
*"te mandei aqui no WhatsApp, dá uma olhada"*.

## Variáveis de ambiente (voz)

| Variável | Descrição |
|----------|-----------|
| `LIVEKIT_URL` | URL do servidor LiveKit (wss://...) |
| `LIVEKIT_API_KEY` | API key LiveKit |
| `LIVEKIT_API_SECRET` | API secret LiveKit |
| `GEMINI_LIVE_MODEL` | Modelo de áudio nativo (gemini-2.5-flash-native-audio-preview-12-2025) |
| `VOZ_SIP_TRUNK` | ID do tronco SIP no LiveKit Cloud |
| `VOZ_CALL_MODE` | `livekit` ou `autocalls` |
| `LK_BIN` | Path do binário LiveKit CLI |
| `VOZ_AFFECTIVE` | Diálogo afetivo (entonação expressiva) 1/0 |
| `VOZ_PROACTIVITY` | Agente proativo (inicia assunto) 1/0 |

## Gerando os áudios de apresentação (PTT)

Os áudios de boas-vindas de cada funcionária (enviados como PTT no WhatsApp quando o contato aciona "Falar com a X") usam **as mesmas vozes Gemini** das ligações ao vivo — para coerência de timbre.

```bash
export GOOGLE_API_KEY=sua-chave
python3 gen-audios.py
# Arquivos .ogg gerados em /opt/empresa-ia/public/ (ou OUT_DIR)
```
