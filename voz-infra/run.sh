#!/bin/bash
# Run the voice agent. Adjust paths to match your deploy location.
set -a; . /opt/empresa-ia/.env; set +a
export HOME=/root
exec /opt/empresa-ia/venv/bin/python /opt/empresa-ia/voz-agente.py start
