// gen-group-icon.js — ÍCONE DE GRUPO do WhatsApp (640x640), TOKEN-FREE (sharp, zero IA).
// WhatsApp RECORTA o ícone num CÍRCULO: tudo importante fica DENTRO do círculo inscrito.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const OUT_DIR = process.env.OUT_DIR || '/opt/empresa-ia/public';
const PHOTO_DIR = process.env.PHOTO_DIR || OUT_DIR;

const SIZE = 640;            // quadrado; WhatsApp corta no círculo inscrito (r=320, centro 320,320)
const JPEG_QUALITY = 90;

// foto (rosto) num círculo no topo do círculo inscrito
const PHOTO_D = 300;
const PHOTO_CX = SIZE / 2;
const PHOTO_CY = 222;

const ICONS = {
  scale: '<path d="M12 3v18M5 21h14M4 8l4-3 4 3M20 8l-4-3-4 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13a4 4 0 0 0 8 0M14 13a4 4 0 0 0 8 0" fill="none" stroke="currentColor" stroke-width="2"/>',
  money: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v10M14.5 9.2C14 8 13 7.5 12 7.5c-1.4 0-2.5.8-2.5 2s1 1.8 2.5 2 2.5.7 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  chart: '<path d="M4 20V4M4 20h16M7 16l4-5 3 3 5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 5.5l3.5 3.5M15 15l3.5 3.5M18.5 5.5L15 9M9 15l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  people: '<circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0-2-5.2M16.5 14c2.5.4 4.5 2.6 4.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  target: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  chat: '<path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V7a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};

const SECTORS = {
  vendas:      { icon: ICONS.chart,    color: '#34a853', label: 'Vendas' },
  comercial:   { icon: ICONS.chart,    color: '#34a853', label: 'Comercial' },
  financeiro:  { icon: ICONS.money,    color: '#fbbc04', label: 'Financeiro' },
  atendimento: { icon: ICONS.lifebuoy, color: '#22c1c3', label: 'Atendimento' },
  redes:       { icon: ICONS.target,   color: '#ff6b4a', label: 'Redes' },
  operacao:    { icon: ICONS.people,   color: '#9b8cff', label: 'Operação' },
  rotina:      { icon: ICONS.calendar, color: '#5b8def', label: 'Rotina' },
  juridico:    { icon: ICONS.scale,    color: '#9b8cff', label: 'Jurídico' },
  default:     { icon: ICONS.chat,     color: '#5b8def', label: 'Empresa.ia' },
};

function resolveSector(setor) {
  const key = String(setor || '').trim().toLowerCase();
  if (SECTORS[key]) return SECTORS[key];
  for (const k of Object.keys(SECTORS)) if (k !== 'default' && key.includes(k)) return SECTORS[k];
  return { ...SECTORS.default, label: setor ? toTitle(setor) : SECTORS.default.label };
}
function toTitle(s) { return String(s).trim().replace(/\s+/g, ' ').replace(/(^|\s)\S/g, (m) => m.toUpperCase()); }
function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'grupo';
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fitAssunto(a, max = 20) {
  const c = String(a || '').trim().replace(/\s+/g, ' ');
  return c.length <= max ? c : c.slice(0, max - 1).trimEnd() + '…';
}
function autoFontSize(t, base = 56, min = 32, perChar = 1.6, ref = 9) {
  return Math.max(min, Math.round(base - Math.max(0, t.length - ref) * perChar));
}
function initials(id) { return (String(id || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?').toUpperCase(); }

async function buildPhotoCircle(employeeId) {
  const photoPath = path.join(PHOTO_DIR, `employee-${employeeId}.jpg`);
  const D = PHOTO_D;
  const mask = Buffer.from(`<svg width="${D}" height="${D}" xmlns="http://www.w3.org/2000/svg"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#fff"/></svg>`);
  let base;
  if (fs.existsSync(photoPath)) {
    // os cards têm NOME à esquerda e ROSTO à direita -> extrai um quadrado da direita (rosto),
    // sem pegar o texto do card. Fallback p/ cover-east se algo der errado.
    try {
      const meta = await sharp(photoPath).metadata();
      const side = Math.min(meta.height, Math.round(meta.height * 0.66));
      const left = Math.max(0, meta.width - side - Math.round(meta.width * 0.03));
      const top = Math.max(0, Math.round((meta.height - side) * 0.32));
      base = await sharp(photoPath).extract({ left, top, width: side, height: side }).resize(D, D, { fit: 'cover' }).toBuffer();
    } catch (e) {
      base = await sharp(photoPath).resize(D, D, { fit: 'cover', position: sharp.gravity.east }).toBuffer();
    }
  } else {
    base = await sharp({ create: { width: D, height: D, channels: 4, background: { r: 26, g: 29, b: 35, alpha: 1 } } }).png().toBuffer();
    const ini = Buffer.from(`<svg width="${D}" height="${D}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(D * 0.4)}" font-weight="700" fill="#ffffff" fill-opacity="0.85">${xmlEscape(initials(employeeId))}</text></svg>`);
    base = await sharp(base).composite([{ input: ini }]).png().toBuffer();
  }
  return sharp(base).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function bgSvg(accent) {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#15181d"/><stop offset="55%" stop-color="#0e1014"/><stop offset="100%" stop-color="#0a0b0e"/></linearGradient><radialGradient id="gl" cx="50%" cy="35%" r="60%"><stop offset="0%" stop-color="${accent}" stop-opacity="0.30"/><stop offset="100%" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/><rect width="${SIZE}" height="${SIZE}" fill="url(#gl)"/></svg>`;
}

function overlaySvg({ assunto, sector }) {
  const W = SIZE, accent = sector.color, cx = W / 2;
  const ring = 312; // anel logo dentro do recorte circular do WhatsApp
  const photoR = PHOTO_D / 2;
  const chipLabel = xmlEscape((sector.label || '').slice(0, 16));
  const chipY = PHOTO_CY + photoR + 18, chipH = 50;
  const textW = Math.round(chipLabel.length * 14.5), iconBox = 26, gap = 9, padX = 22;
  const chipW = Math.min(W - 150, padX * 2 + iconBox + gap + textW);
  const chipX = cx - chipW / 2;
  const contentW = iconBox + gap + textW;
  const iconX = chipX + (chipW - contentW) / 2, iconY = chipY + (chipH - iconBox) / 2;
  const labelX = iconX + iconBox + gap + textW / 2;
  const aTxt = xmlEscape(fitAssunto(assunto));
  const aY = chipY + chipH + 64;
  const aFs = autoFontSize(aTxt);
  return `<svg width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg"><defs><filter id="sh" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="6" stdDeviation="14" flood-color="#000" flood-opacity="0.6"/></filter></defs>` +
    `<circle cx="${cx}" cy="${PHOTO_CY}" r="${photoR + 6}" fill="none" stroke="${accent}" stroke-opacity="0.6" stroke-width="5"/>` +
    `<g filter="url(#sh)"><rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="${chipH / 2}" fill="#0d0f13" fill-opacity="0.9" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.5"/></g>` +
    `<g transform="translate(${iconX} ${iconY}) scale(${iconBox / 24})" color="${accent}">${sector.icon}</g>` +
    `<text x="${labelX}" y="${chipY + chipH / 2}" dy="0.34em" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="600" fill="#f5f5f7">${chipLabel}</text>` +
    `<text x="${cx}" y="${aY}" dy="0.34em" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${aFs}" font-weight="800" fill="#ffffff" filter="url(#sh)">${aTxt}</text>` +
    `<circle cx="${cx}" cy="${cx}" r="${ring}" fill="none" stroke="${accent}" stroke-opacity="0.25" stroke-width="3"/>` +
    `</svg>`;
}

async function genGroupIcon({ employeeId, assunto, setor, outDir = OUT_DIR, force = false } = {}) {
  if (employeeId == null || String(employeeId).trim() === '') throw new Error('genGroupIcon: employeeId obrigatorio');
  if (!assunto || !String(assunto).trim()) throw new Error('genGroupIcon: assunto obrigatorio');
  const out = path.join(outDir, `group-${employeeId}-${slugify(assunto)}.jpg`);
  // cache: ícone (id+assunto) é determinístico — não regera na hora se já existe
  if (!force && fs.existsSync(out)) return out;
  const sector = resolveSector(setor);
  const photo = await buildPhotoCircle(employeeId);
  const bg = await sharp(Buffer.from(bgSvg(sector.color))).png().toBuffer();
  const withPhoto = await sharp(bg).composite([{ input: photo, top: Math.round(PHOTO_CY - PHOTO_D / 2), left: Math.round((SIZE - PHOTO_D) / 2) }]).png().toBuffer();
  await sharp(withPhoto).composite([{ input: Buffer.from(overlaySvg({ assunto, sector })) }]).jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' }).toFile(out);
  return out;
}

module.exports = { genGroupIcon, slugify, resolveSector, SECTORS };

if (require.main === module) {
  const [employeeId, assunto, setor] = process.argv.slice(2);
  if (!employeeId || !assunto) { console.error('Uso: node gen-group-icon.js <employeeId> "<assunto>" "<setor>"'); process.exit(1); }
  genGroupIcon({ employeeId, assunto, setor }).then((o) => console.log(`OK -> ${o}`)).catch((e) => { console.error(`ERRO: ${e.message}`); process.exit(1); });
}
