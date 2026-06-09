// Gera cards 4:3 dark (estilo Apple) pra cada app integravel: logo Composio + nome + status.
// Usa sharp (ja instalado no bridge). Saida: /opt/empresa-ia/public/app-<slug>.jpg
const https = require('https');
const sharp = require('sharp');
const path = require('path');

const OUT_DIR = process.env.OUT_DIR || '/opt/empresa-ia/public';

// status: cor do "pill" e texto
const APPS = [
  { slug: 'gmail',          name: 'Gmail',          status: 'Toque para conectar', color: '#5b8def' },
  { slug: 'googlecalendar', name: 'Google Agenda',  status: 'Reconectar',          color: '#fbbc04' },
  { slug: 'googlesheets',   name: 'Google Sheets',  status: 'Toque para conectar', color: '#34a853' },
  { slug: 'googledrive',    name: 'Google Drive',   status: 'Toque para conectar', color: '#5b8def' },
];

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'empresaia' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuf(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

const W = 1200, H = 900;

function cardSvg(app, logoB64) {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#15181d"/>
      <stop offset="55%" stop-color="#0e1014"/>
      <stop offset="100%" stop-color="#0a0b0e"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="34%" r="42%">
      <stop offset="0%" stop-color="${app.color}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${app.color}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="430" y="150" width="340" height="340" rx="64" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>
  <image x="500" y="220" width="200" height="200" href="data:image/svg+xml;base64,${logoB64}"/>
  <text x="600" y="610" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="78" font-weight="700" fill="#f5f5f7">${app.name}</text>
  <rect x="${600 - 220}" y="670" width="440" height="74" rx="37" fill="${app.color}" fill-opacity="0.16" stroke="${app.color}" stroke-opacity="0.55" stroke-width="2"/>
  <text x="600" y="719" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="600" fill="${app.color}">${app.status}</text>
</svg>`;
}

async function gen(app) {
  const logo = await fetchBuf(`https://logos.composio.dev/api/${app.slug}`);
  const b64 = logo.toString('base64');
  const svg = cardSvg(app, b64);
  const out = path.join(OUT_DIR, `app-${app.slug}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out);
  console.log(`OK ${app.slug} -> ${out}`);
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? APPS.filter(a => only.includes(a.slug)) : APPS;
  for (const a of list) {
    try { await gen(a); } catch (e) { console.log(`ERRO ${a.slug}: ${e.message}`); }
  }
})();
