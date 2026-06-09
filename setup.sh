#!/usr/bin/env bash
set -euo pipefail

# Empresa.ia — First-time setup
# Usage: ./setup.sh

echo "=== Empresa.ia — Setup ==="
echo ""

# ---------- Verificar pré-requisitos ----------

check_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Erro: '$1' nao encontrado. Instale e tente de novo."; exit 1; }
}

check_cmd node
check_cmd npm
check_cmd python3

NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "Erro: Node.js 18+ necessario (encontrado: $(node --version))."
  exit 1
fi

PY_VER=$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo "0")
PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo "0")
if [ "$PY_MAJOR" -lt 3 ] || [ "$PY_VER" -lt 11 ]; then
  echo "Aviso: Python 3.11+ recomendado para voz-agente.py (encontrado: $(python3 --version))."
fi

echo "[OK] Node.js $(node --version)"
echo "[OK] Python $(python3 --version)"

# ffmpeg (transcrição de vídeo/áudio)
if command -v ffmpeg >/dev/null 2>&1; then
  echo "[OK] ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  echo "[AVISO] ffmpeg nao encontrado. Transcrição de video/audio ficara indisponivel."
  echo "        Para instalar:"
  echo "          Ubuntu/Debian: sudo apt install ffmpeg"
  echo "          macOS:         brew install ffmpeg"
fi

echo ""

# ---------- Ambiente ----------

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] .env criado a partir de .env.example"
  echo "     Edite o arquivo .env com suas chaves antes de iniciar."
else
  echo "[OK] .env ja existe"
fi

if [ ! -f instances.json ]; then
  cp instances.json.example instances.json
  echo "[OK] instances.json criado a partir de instances.json.example"
  echo "     Edite instances.json com seu token e numero uazapi."
else
  echo "[OK] instances.json ja existe"
fi

if [ ! -f ecosystem.local.config.cjs ]; then
  cp ecosystem.config.cjs ecosystem.local.config.cjs
  echo "[OK] ecosystem.local.config.cjs criado"
  echo "     Edite o arquivo com o caminho correto de deploy (cwd)."
else
  echo "[OK] ecosystem.local.config.cjs ja existe"
fi

echo ""

# ---------- Dependências Node.js ----------

echo "Instalando dependencias Node.js..."
npm install
echo "[OK] npm install concluido"

echo ""

# ---------- Diretórios de runtime ----------

RUNTIME_DIR="${RUNTIME_DIR:-/opt/empresa-ia}"
if [ ! -d "$RUNTIME_DIR" ]; then
  echo "[INFO] Diretorio de runtime '$RUNTIME_DIR' nao existe."
  echo "       Crie-o em producao: sudo mkdir -p $RUNTIME_DIR && sudo chown \$USER $RUNTIME_DIR"
fi

echo ""
echo "=== Setup concluido! ==="
echo ""
echo "Proximos passos:"
echo "  1. Edite .env com suas chaves (uazapi, OpenClaw, Groq, Gemini, LiveKit, Composio)"
echo "  2. Edite instances.json com seu token e numero WhatsApp"
echo "  3. Configure o webhook no painel uazapi: POST /hook/<WEBHOOK_SECRET>"
echo "  4. Inicie o bridge: node bridge.js"
echo "  5. (Voz) Instale deps Python: python3 -m venv venv && venv/bin/pip install livekit-agents livekit-plugins-google"
echo "  6. (Voz) Suba o LiveKit: cd voz-infra && docker compose up -d"
echo "  7. (Voz) Inicie o agente: python3 voz-agente.py start"
echo "  8. Usando Claude Code? CLAUDE.md tem todo o contexto do projeto."
echo ""
echo "  Health check (quando o bridge estiver rodando):"
echo "    curl http://localhost:8090/health"
