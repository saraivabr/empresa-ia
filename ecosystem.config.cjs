// PM2 ecosystem config for Empresa.ia bridge.
// All sensitive values must be set via environment variables or a .env file.
// See .env.example for the full list of required variables.
//
// Usage:
//   cp ecosystem.config.cjs ecosystem.local.config.cjs
//   # Edit ecosystem.local.config.cjs with your values
//   pm2 start ecosystem.local.config.cjs
const { existsSync, readFileSync } = require('fs');

// Optional: load webhook secret from a local file (keeps it out of env)
const webhookSecretPath = process.env.WEBHOOK_SECRET_FILE || '/opt/empresa-ia/.webhook_secret';
const webhookSecret = existsSync(webhookSecretPath)
  ? readFileSync(webhookSecretPath, 'utf8').trim()
  : (process.env.WEBHOOK_SECRET || '');

module.exports = {
  apps: [{
    name: 'empresa-ia-bridge',
    script: 'bridge.js',
    cwd: '/opt/empresa-ia',          // change to your deploy path
    time: true,
    max_restarts: 20,
    restart_delay: 3000,
    env: {
      HOME: '/root',
      INSTANCES_FILE: '/opt/empresa-ia/instances.json',
      OPENCLAW_BIN: '/usr/bin/openclaw',
      AGENT_TIMEOUT_SEC: '180',
      DEBOUNCE_MS: '1500',
      HEALTH_PORT: '8090',
      BIND_HOST: '127.0.0.1',        // set to your internal Docker/Caddy bridge IP if needed
      ...(webhookSecret ? { WEBHOOK_SECRET: webhookSecret } : {}),
      ENABLE_SSE: '1',
      PREWARM_MS: '240000',
      OWNER_NUMBERS: '',             // comma-separated owner WhatsApp numbers (digits only, no +)
      // Additional required env vars — see .env.example:
      // UAZ_TOKEN, UAZ_ADMIN_TOKEN, GROQ_API_KEY, GOOGLE_API_KEY, LIVEKIT_API_KEY,
      // LIVEKIT_API_SECRET, LIVEKIT_URL, COMPOSIO_API_KEY, ASSET_BASE, etc.
    }
  }]
};
