#!/bin/bash
# Sentinela — vigia bridge + voz + livekit e avisa o dono NO WHATSAPP quando cair/voltar.
# Roda via cron (*/5). Alerta só na MUDANÇA de estado (não spamma a cada 5min).
set -u

ENV_FILE="/opt/voz-agente/.env"   # tem UAZ_SERVER/UAZ_TOKEN (instância da Empresa.ia)
OWNER="${SENTINELA_OWNER:-${SENTINELA_OWNER}}"
STATE="/var/tmp/sentinela.state"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

fail=""
curl -fsS -m 8 http://127.0.0.1:8090/health >/dev/null 2>&1 || fail="$fail bridge"
systemctl is-active --quiet voz-agente.service || fail="$fail voz-agente"
docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^livekit-livekit' || fail="$fail livekit"
docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^livekit-sip' || fail="$fail sip"
fail="$(echo "$fail" | xargs || true)"

prev="$(cat "$STATE" 2>/dev/null || true)"

avisa() {
  [ -n "${UAZ_SERVER:-}" ] && [ -n "${UAZ_TOKEN:-}" ] || return 0
  curl -fsS -m 10 -X POST "$UAZ_SERVER/send/text" \
    -H "token: $UAZ_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"number\":\"$OWNER\",\"text\":\"$1\"}" >/dev/null 2>&1 || true
}

if [ -n "$fail" ]; then
  if [ "$prev" != "$fail" ]; then
    avisa "🚨 *Sentinela*: serviço fora do ar: $fail (servidor ${SENTINELA_HOST:-seu-servidor}). Ligações/atendimento podem estar afetados."
    logger -t sentinela "DOWN: $fail"
  fi
  printf '%s' "$fail" > "$STATE"
else
  if [ -n "$prev" ]; then
    avisa "✅ *Sentinela*: tudo de volta no ar ($prev recuperado)."
    logger -t sentinela "RECOVERED: $prev"
  fi
  : > "$STATE"
fi
