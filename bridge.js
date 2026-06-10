// uazapi <-> OpenClaw bridge — Empresa.ia
// Inbound robusto: WEBHOOK (primário) + SSE (fallback) com deduplicação por messageId.
// openclaw agent (sessão por peer) -> diretivas <uazapi> -> envio rico.
'use strict';
const fs = require('fs');
const http = require('http');
const axios = require('axios');
const EventSource = require('eventsource');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');

// ---------- config ----------
const CFG = JSON.parse(fs.readFileSync(process.env.INSTANCES_FILE || '/opt/empresa-ia/instances.json', 'utf8'));
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/usr/bin/openclaw';
const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT_SEC || '180', 10);
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '900', 10);
const THINK_DELAY_MS = parseInt(process.env.THINK_DELAY_MS || '3500', 10); // mostra "pensando" após 3,5s — preenche a espera com as frases charmosas em vez de silêncio
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8090', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'; // 172.19.0.1 p/ Caddy alcançar (webhook)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // segredo no path: /hook/<secret>
const ENABLE_SSE = process.env.ENABLE_SSE !== '0'; // SSE de fallback (default ligado)
const PREWARM_MS = parseInt(process.env.PREWARM_MS || '0', 10); // keep-warm da sessão (0 = off)
const OWNER = (process.env.OWNER_NUMBERS || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/opt/empresa-ia/public';
const ASSET_BASE = process.env.ASSET_BASE || 'https://jesus.185.182.184.122.nip.io/assets/';
const EMPRESAIA_USAGE_FILE = process.env.EMPRESAIA_USAGE_FILE || '/opt/empresa-ia/empresaia-usage.json';
const WAVOIP_BASE_URL = process.env.WAVOIP_BASE_URL || '';
const WAVOIP_API_KEY = process.env.WAVOIP_API_KEY || '';
const WAVOIP_CALL_ENDPOINT = process.env.WAVOIP_CALL_ENDPOINT || '/calls/whatsapp';
const WAVOIP_DEVICE_URL = process.env.WAVOIP_DEVICE_URL || 'https://devices.wavoip.com';
const WAVOIP_TIMEOUT_MS = parseInt(process.env.WAVOIP_TIMEOUT_MS || '30000', 10);
const ENABLE_AUDIO_TRANSCRIPTION = process.env.ENABLE_AUDIO_TRANSCRIPTION !== '0';
const GEMINI_TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.5-flash';
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const isOwnerChatid = (chatid) => OWNER.includes(onlyDigits(chatid));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// contadores p/ health (visibilidade)
const stats = { received: 0, deduped: 0, answered: 0, empty: 0, errors: 0, viaWebhook: 0, viaSSE: 0, callsStarted: 0, callsFailed: 0, postCalls: 0, lastInboundAt: null, lastAnswerAt: null, lastCallAt: null, lastPostCallAt: null };

let empresaiaUsage = {};
let empresaiaUsageSaveTimer = null;
try {
  empresaiaUsage = JSON.parse(fs.readFileSync(EMPRESAIA_USAGE_FILE, 'utf8'));
} catch {
  empresaiaUsage = {};
}

function usageKeyForChat(chatid) {
  return onlyDigits(chatid) || String(chatid || 'unknown');
}

function empresaiaUsageProfile(chatid) {
  const key = usageKeyForChat(chatid);
  if (!empresaiaUsage[key]) {
    empresaiaUsage[key] = {
      createdAt: new Date().toISOString(),
      updatedAt: null,
      total: 0,
      commands: {},
      categories: {},
      recent: [],
    };
  }
  return empresaiaUsage[key];
}

function scheduleEmpresaiaUsageSave() {
  if (empresaiaUsageSaveTimer) return;
  empresaiaUsageSaveTimer = setTimeout(() => {
    empresaiaUsageSaveTimer = null;
    try {
      fs.writeFileSync(EMPRESAIA_USAGE_FILE, JSON.stringify(empresaiaUsage, null, 2));
    } catch (e) {
      log('[empresaia] nao consegui salvar usage:', e.message);
    }
  }, 1000);
  empresaiaUsageSaveTimer.unref?.();
}

function empresaiaCategoryFor(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('crm') || s.includes('receita') || s.includes('lead')) return 'receita';
  if (s.includes('meta') || s.includes('google') || s.includes('ads') || s.includes('crescimento')) return 'crescimento';
  if (s.includes('ig') || s.includes('insta') || s.includes('conteudo')) return 'conteudo';
  if (s.includes('wa') || s.includes('whatsapp') || s.includes('atendimento')) return 'atendimento';
  if (s.includes('auto') || s.includes('routine') || s.includes('rotina')) return 'automacoes';
  if (s.includes('financeiro') || s.includes('caixa')) return 'financeiro';
  if (s.includes('site')) return 'sites';
  if (s.includes('ceo')) return 'ceo';
  if (s.includes('radar')) return 'radar';
  if (s.includes('warroom') || s.includes('mission')) return 'warroom';
  return 'geral';
}

function recordEmpresaiaUsage(chatid, input) {
  const key = String(input || '').trim().toLowerCase();
  if (!key) return;
  const profile = empresaiaUsageProfile(chatid);
  const now = new Date().toISOString();
  const cat = empresaiaCategoryFor(key);
  profile.total = (profile.total || 0) + 1;
  profile.updatedAt = now;
  profile.commands[key] = (profile.commands[key] || 0) + 1;
  profile.categories[cat] = (profile.categories[cat] || 0) + 1;
  profile.recent = [{ id: key, category: cat, at: now }, ...(profile.recent || [])].slice(0, 30);
  scheduleEmpresaiaUsageSave();
}

function usageScore(profile, card) {
  if (!profile) return 0;
  const cats = Array.isArray(card.categories) ? card.categories : [card.category || empresaiaCategoryFor(card.buttons?.[0]?.[0])];
  const commandHits = (card.buttons || []).reduce((sum, [id]) => sum + (profile.commands?.[String(id).toLowerCase()] || 0), 0);
  const categoryHits = cats.reduce((sum, cat) => sum + (profile.categories?.[cat] || 0), 0);
  const recentHits = (profile.recent || []).reduce((sum, item, index) => {
    if (cats.includes(item.category)) return sum + Math.max(1, 12 - index);
    if ((card.buttons || []).some(([id]) => String(id).toLowerCase() === item.id)) return sum + Math.max(1, 16 - index);
    return sum;
  }, 0);
  return commandHits * 5 + categoryHits * 2 + recentHits;
}

function personalizeCards(cards, chatid) {
  const profile = empresaiaUsageProfile(chatid);
  return cards
    .map((card, index) => ({ ...card, _index: index, _score: usageScore(profile, card) }))
    .sort((a, b) => (b._score - a._score) || (a._index - b._index))
    .map(({ _index, _score, ...card }) => card);
}

function usageContextText(chatid) {
  const profile = empresaiaUsageProfile(chatid);
  if (!profile.total) return '';
  const top = Object.entries(profile.categories || {}).sort((a, b) => b[1] - a[1])[0];
  if (!top) return '';
  const labels = {
    receita: 'receita',
    crescimento: 'crescimento',
    conteudo: 'conteudo',
    atendimento: 'atendimento',
    automacoes: 'automacoes',
    financeiro: 'financeiro',
    sites: 'sites',
    ceo: 'decisao',
    radar: 'radar',
    warroom: 'missoes',
  };
  if (!labels[top[0]]) return '';
  return `Priorizei por uso recente: ${labels[top[0]]}.`;
}

// ---------- extração defensiva do payload uazapi ----------
function extractChatid(d) {
  return d.chatid || d.from || d.sender || d.jid || d.key?.remoteJid || d.message?.chatid || null;
}
function extractMsgId(d) {
  return d.messageid || d.id || d.key?.id || d.message?.id || d.message?.key?.id
    || `${extractChatid(d) || '?'}:${(extractText(d) || '').slice(0, 40)}:${d.messageTimestamp || d.timestamp || ''}`;
}
function extractText(d) {
  return d.text
    || d.buttonOrListid                              // clique em botão/lista (uazapi)
    || d.content?.Response?.SelectedDisplayText       // resposta interativa
    || d.content?.selectedButtonID
    || d.content?.text
    || d.message?.conversation
    || d.message?.extendedTextMessage?.text
    || (typeof d.message === 'string' ? d.message : null)
    || (typeof d.body === 'string' ? d.body : null)
    || (typeof d.content === 'string' ? d.content : null)
    || '';
}
function findAudioMessage(d) {
  // formato REAL uazapi: messageType === 'AudioMessage' e os dados ficam direto em content
  if (/audio|ptt|voice/i.test(String(d.messageType || '')) && d.content && typeof d.content === 'object' && (d.content.URL || d.content.url || d.content.mediaKey)) {
    return d.content;
  }
  // shape plano: messageType de audio + URL/fileURL no topo (algumas versões do uazapi)
  if (/audio|ptt|voice/i.test(String(d.messageType || '')) && (d.fileURL || d.URL || d.url || d.mediaKey)) {
    return { ...d, url: d.fileURL || d.URL || d.url, URL: d.fileURL || d.URL || d.url };
  }
  const candidates = [
    d.audioMessage,
    d.message?.audioMessage,
    d.content?.audioMessage,
    d.content?.AudioMessage,
    d.content?.contextInfo?.quotedMessage?.audioMessage,
    d.content?.contextInfo?.quotedMessage?.AudioMessage,
    d.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage,
    d.message?.extendedTextMessage?.contextInfo?.quotedMessage?.AudioMessage,
  ].filter(Boolean);
  return candidates.find(a => a.URL || a.url || a.mediaKey) || null;
}
function normalizeAudioMessage(audio) {
  if (!audio || typeof audio !== 'object') return null;
  return {
    ...audio,
    url: audio.url || audio.URL,
    fileSha256: audio.fileSha256 || audio.fileSHA256,
    fileEncSha256: audio.fileEncSha256 || audio.fileEncSHA256,
    mimetype: audio.mimetype || audio.mimeType || 'audio/ogg; codecs=opus',
    mediaKey: audio.mediaKey,
    directPath: audio.directPath,
  };
}
function isGroup(d) {
  const c = String(extractChatid(d) || '');
  return d.isGroup === true || /@g\.us$/.test(c);
}
function isFromMe(d) {
  return d.fromMe === true || d.key?.fromMe === true || d.wasSentByApi === true;
}
function senderName(d) {
  return d.senderName || d.pushName || d.notifyName || d.displayName || d.message?.pushName || null;
}
function extractSenderChatid(d) {
  const candidates = [
    d.sender_pn,
    d.sender,
    d.participant,
    d.author,
    d.key?.participant,
    d.message?.key?.participant,
    d.message?.participant,
  ].filter(Boolean);
  const phone = candidates.find(c => /@s\.whatsapp\.net$/.test(String(c)) || onlyDigits(c).length >= 10);
  if (!phone) return null;
  const s = String(phone);
  return /@/.test(s) ? s : `${onlyDigits(s)}@s.whatsapp.net`;
}
function selfIds(inst) {
  return [onlyDigits(inst.number || ''), onlyDigits(inst.lid || '')].filter(Boolean);
}
function isMentioned(d, inst) {
  const ids = selfIds(inst);
  if (!ids.length) return false;
  // 1. array de menções (quando o uazapi entregar)
  const ment = d.mentions || d.mentionedJid || d.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const arr = Array.isArray(ment) ? ment.map(onlyDigits) : [];
  if (ids.some(id => arr.includes(id))) return true;
  // 2. menção no texto cru: @<numero> ou @<lid> — WhatsApp moderno usa LID
  const raw = String(extractText(d) || '');
  if (ids.some(id => raw.includes('@' + id))) return true;
  // 3. reply/quote para o próprio bot
  const q = d.quoted || d.message?.extendedTextMessage?.contextInfo?.participant;
  if (q && ids.some(id => onlyDigits(JSON.stringify(q)).includes(id))) return true;
  return false;
}
// remove a menção crua (@<lid>/@<numero>) do texto antes de mandar ao agente
function cleanMentions(text, inst) {
  let t = String(text || '');
  for (const id of selfIds(inst)) t = t.split('@' + id).join('');
  return t.replace(/\s+/g, ' ').trim();
}

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    return cfg?.models?.providers?.google?.apiKey || '';
  } catch {
    return '';
  }
}

async function downloadAudioBuffer(audio) {
  const normalized = normalizeAudioMessage(audio);
  if (!normalized?.url) { log('[audio] download: sem url'); return null; }
  // mídia já hospedada/decifrada (url http sem mediaKey) -> baixa direto (baileys exige mediaKey)
  if (!normalized.mediaKey && /^https?:\/\//i.test(String(normalized.url))) {
    try {
      const { data } = await axios.get(normalized.url, { responseType: 'arraybuffer', timeout: 45000 });
      return { buffer: Buffer.from(data), mimetype: normalized.mimetype || 'audio/ogg' };
    } catch (e) { stats.errors++; log('[audio] download direto falhou:', e.response?.status || e.message); return null; }
  }
  if (!normalized.mediaKey) { log('[audio] download: mediaKey ausente e url nao http'); return null; }
  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(normalized, 'audio');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), mimetype: normalized.mimetype || 'audio/ogg' };
}

// Groq Whisper — rápido e robusto pra ogg/opus do WhatsApp (motor primário de transcrição)
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo';

async function transcribeViaGroq(media) {
  if (!GROQ_API_KEY) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([media.buffer], { type: String(media.mimetype || 'audio/ogg').split(';')[0] }), 'audio.ogg');
    form.append('model', GROQ_TRANSCRIBE_MODEL);
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const { data } = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      timeout: 45000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    const text = String(data?.text || '').trim();
    if (text) log(`[audio] groq transcrito ${media.buffer.length}b -> ${text.slice(0, 80)}`);
    return text || null;
  } catch (e) {
    log('[audio] groq falhou:', e.response?.status || e.message, JSON.stringify(e.response?.data || '').slice(0, 160));
    return null;
  }
}

async function transcribeAudio(audio) {
  if (!ENABLE_AUDIO_TRANSCRIPTION) return null;
  const media = await downloadAudioBuffer(audio);
  if (!media?.buffer?.length) return null;
  // Groq Whisper primeiro (rápido/robusto). Se faltar chave ou falhar, cai no Gemini.
  const viaGroq = await transcribeViaGroq(media);
  if (viaGroq) return viaGroq;
  const apiKey = getGeminiApiKey();
  if (!apiKey) { log('[audio] sem GROQ_API_KEY nem chave Gemini para transcrever'); return null; }
  try {
    const mimeType = String(media.mimetype || 'audio/ogg').split(';')[0];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`;
    const { data } = await axios.post(url, {
      contents: [{
        parts: [
          { text: 'Transcreva este áudio de WhatsApp em português do Brasil. Responda somente com a transcrição literal, sem comentários.' },
          { inlineData: { mimeType, data: media.buffer.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0 },
    }, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: 45000,
    });
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n').trim();
    if (text) log(`[audio] gemini transcrito ${media.buffer.length} bytes -> ${text.slice(0, 80)}`);
    return text || null;
  } catch (e) {
    stats.errors++;
    log('[audio] transcricao falhou (groq+gemini):', e.response?.status || e.message, JSON.stringify(e.response?.data || '').slice(0, 200));
    return null;
  }
}

async function enrichTextWithAudio(data, text) {
  const audio = findAudioMessage(data);
  if (!audio) return text;
  const transcript = await transcribeAudio(audio);
  if (!transcript) {
    const base = String(text || '').trim();
    return `${base ? `${base}\n\n` : ''}[Audio recebido, mas a transcricao falhou. Peça para a pessoa reenviar ou resumir.]`;
  }
  const base = String(text || '').trim();
  const quoted = data.quoted || data.content?.contextInfo?.stanzaID || '';
  return `${base ? `${base}\n\n` : ''}[Audio transcrito${quoted ? ` do recado citado ${quoted}` : ''}]\n${transcript}`;
}

// ---------- imagem recebida: descreve via Gemini vision (pra NAO alucinar) ----------
function findImageMessage(d) {
  // formato REAL uazapi: messageType === 'ImageMessage' e os dados ficam direto em content
  if (/image|imagem/i.test(String(d.messageType || '')) && d.content && typeof d.content === 'object' && (d.content.URL || d.content.url || d.content.mediaKey)) {
    return d.content;
  }
  if (/image|imagem/i.test(String(d.messageType || '')) && (d.fileURL || d.URL || d.url || d.mediaKey)) {
    return { ...d, url: d.fileURL || d.URL || d.url, URL: d.fileURL || d.URL || d.url };
  }
  const candidates = [
    d.imageMessage, d.message?.imageMessage, d.content?.imageMessage, d.content?.ImageMessage,
    d.content?.contextInfo?.quotedMessage?.imageMessage,
    d.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage,
  ].filter(Boolean);
  return candidates.find(a => a.URL || a.url || a.mediaKey) || null;
}
function normalizeImageMessage(img) {
  if (!img || typeof img !== 'object') return null;
  return {
    ...img,
    url: img.url || img.URL,
    fileSha256: img.fileSha256 || img.fileSHA256,
    fileEncSha256: img.fileEncSha256 || img.fileEncSHA256,
    mimetype: img.mimetype || img.mimeType || 'image/jpeg',
    mediaKey: img.mediaKey,
    directPath: img.directPath,
  };
}
async function downloadImageBuffer(img) {
  const n = normalizeImageMessage(img);
  if (!n?.url) { log('[image] download: sem url'); return null; }
  if (!n.mediaKey && /^https?:\/\//i.test(String(n.url))) {
    try {
      const { data } = await axios.get(n.url, { responseType: 'arraybuffer', timeout: 45000 });
      return { buffer: Buffer.from(data), mimetype: n.mimetype || 'image/jpeg' };
    } catch (e) { stats.errors++; log('[image] download direto falhou:', e.response?.status || e.message); return null; }
  }
  if (!n.mediaKey) { log('[image] download: mediaKey ausente e url nao http'); return null; }
  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(n, 'image');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), mimetype: n.mimetype || 'image/jpeg' };
}
const IMG_PROMPT = 'Descreva objetivamente, em português, o que aparece nesta imagem, incluindo qualquer texto/número visível. Seja fiel e conciso — NÃO invente o que não dá pra ver.';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
// fallback de visão pelo Groq (quando o Gemini falta ou estoura a cota 429/503). Reusa o buffer já baixado.
async function describeImageViaGroq(buffer, mimeType) {
  if (!GROQ_API_KEY || !buffer?.length) return null;
  try {
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_VISION_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: IMG_PROMPT },
        { type: 'image_url', image_url: { url: dataUri } },
      ] }],
      temperature: 0,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 45000, maxBodyLength: Infinity });
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (text) log(`[image] groq vision ${buffer.length}b -> ${text.slice(0, 80)}`);
    return text || null;
  } catch (e) {
    log('[image] groq vision falhou:', e.response?.status || e.message, JSON.stringify(e.response?.data || '').slice(0, 160));
    return null;
  }
}
async function describeImage(img) {
  const media = await downloadImageBuffer(img);
  if (!media?.buffer?.length) return null;
  const mimeType = String(media.mimetype || 'image/jpeg').split(';')[0];
  // 1) Gemini vision (primário). Se faltar chave ou estourar cota (429/503), cai no Groq.
  const apiKey = getGeminiApiKey();
  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`;
      const { data } = await axios.post(url, {
        contents: [{ parts: [{ text: IMG_PROMPT }, { inlineData: { mimeType, data: media.buffer.toString('base64') } }] }],
        generationConfig: { temperature: 0 },
      }, { headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 45000 });
      const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n').trim();
      if (text) { log(`[image] gemini vision ${media.buffer.length}b -> ${text.slice(0, 80)}`); return text; }
    } catch (e) {
      log('[image] gemini vision falhou:', e.response?.status || e.message, '— tentando Groq');
    }
  }
  // 2) fallback Groq vision (resiliente à cota do Gemini)
  const viaGroq = await describeImageViaGroq(media.buffer, mimeType);
  if (!viaGroq) stats.errors++;
  return viaGroq;
}
async function enrichTextWithImage(data, text) {
  const img = findImageMessage(data);
  if (!img) return text;
  const caption = String(img.caption || img.Caption || '').trim();
  const desc = await describeImage(img);
  const base = String(text || '').trim();
  if (!desc) {
    return `${base ? base + '\n\n' : ''}[Imagem recebida, mas não consegui abrir agora. Diga com franqueza que não conseguiu ver a imagem e peça pra reenviar ou descrever — NUNCA finja que viu.]${caption ? '\nLegenda: ' + caption : ''}`;
  }
  return `${base ? base + '\n\n' : ''}[A pessoa mandou uma IMAGEM. Isto é o que aparece nela:]\n${desc}${caption ? '\nLegenda escrita pela pessoa: ' + caption : ''}`;
}

// ---------- DOCUMENTO/arquivo recebido: reconhece (nome + tipo) pra não cair no vácuo ----------
function findDocumentMessage(d) {
  if (/document|arquivo/i.test(String(d.messageType || '')) && d.content && typeof d.content === 'object' && (d.content.URL || d.content.url || d.content.mediaKey || d.content.fileName || d.content.title)) {
    return d.content;
  }
  if (/document/i.test(String(d.messageType || '')) && (d.fileURL || d.URL || d.url || d.fileName)) return d;
  const c = [d.documentMessage, d.message?.documentMessage, d.content?.documentMessage, d.content?.DocumentMessage,
    d.documentWithCaptionMessage?.message?.documentMessage].filter(Boolean);
  return c.find(a => a.URL || a.url || a.fileName || a.title || a.mediaKey) || null;
}
function enrichTextWithDocument(data, text) {
  const doc = findDocumentMessage(data);
  if (!doc) return text;
  const nome = String(doc.fileName || doc.title || doc.docName || 'arquivo').trim();
  const tipo = (String(doc.mimetype || doc.mimeType || '').split(';')[0]) || 'desconhecido';
  const pgs = doc.pageCount ? `, ${doc.pageCount} páginas` : '';
  const cap = String(doc.caption || doc.Caption || '').trim();
  const base = String(text || '').trim();
  return `${base ? base + '\n\n' : ''}[A pessoa mandou um ARQUIVO: "${nome}" (tipo: ${tipo}${pgs}). Reconheça o arquivo pelo nome de forma natural e pergunte o que ela quer que você faça com ele. NÃO finja que leu o conteúdo — ainda não consigo abrir o conteúdo de arquivos por aqui.]${cap ? '\nLegenda: ' + cap : ''}`;
}

// ---------- VÍDEO recebido: ouve (extrai áudio -> Groq) + vê 1 frame (Gemini vision) ----------
function geminiVisionBuffer(buffer, mime, prompt) {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !buffer?.length) return Promise.resolve(null);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`;
  return axios.post(url, {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: String(mime || 'image/jpeg').split(';')[0], data: buffer.toString('base64') } }] }],
    generationConfig: { temperature: 0 },
  }, { headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 45000 })
    .then(({ data }) => (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n').trim() || null)
    .catch((e) => { log('[vision] falhou:', e.response?.status || e.message); return null; });
}
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const c = spawn('ffmpeg', args, { stdio: 'ignore' });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} resolve(false); }, 60000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
// ---------- TTS dinâmico (Gemini) -> PTT do WhatsApp, gerado na hora pra cada lead ----------
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE_SOFIA = process.env.TTS_VOICE_SOFIA || 'Sulafat'; // mesma voz da Sofia (coerência)
// gera um .ogg (opus) a partir de um roteiro, na voz da Sofia. Retorna o nome do arquivo ou null.
async function gerarAudioTTS(slug, texto, estilo) {
  const apiKey = getGeminiApiKey();
  if (!apiKey || !texto) return null;
  const prefixo = estilo || 'Fale como uma brasileira calorosa, próxima e empolgada, ritmo de conversa de verdade (não locução): ';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;
  try {
    const { data } = await axios.post(url, {
      contents: [{ parts: [{ text: prefixo + texto }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE_SOFIA } } } },
    }, { headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 60000 });
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) { log('[tts] resposta sem áudio'); return null; }
    const safe = String(slug || 'lead').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'lead';
    const pcm = `/tmp/tts-${safe}.pcm`;
    const ogg = `${PUBLIC_DIR}/${safe}.ogg`;
    fs.writeFileSync(pcm, Buffer.from(b64, 'base64'));
    const ok = await runFfmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-c:a', 'libopus', '-b:a', '32k', ogg]);
    try { fs.unlinkSync(pcm); } catch {}
    if (!ok || !fs.existsSync(ogg)) { log('[tts] ffmpeg falhou'); return null; }
    log(`[tts] gerado ${safe}.ogg (${fs.statSync(ogg).size}b)`);
    return `${safe}.ogg`;
  } catch (e) {
    log('[tts] falhou:', e.response?.status || e.message);
    return null;
  }
}
function findVideoMessage(d) {
  if (/video|vídeo/i.test(String(d.messageType || '')) && d.content && typeof d.content === 'object' && (d.content.URL || d.content.url || d.content.mediaKey)) return d.content;
  if (/video|vídeo/i.test(String(d.messageType || '')) && (d.fileURL || d.URL || d.url || d.mediaKey)) return { ...d, url: d.fileURL || d.URL || d.url, URL: d.fileURL || d.URL || d.url };
  const c = [d.videoMessage, d.message?.videoMessage, d.content?.videoMessage, d.content?.VideoMessage,
    d.content?.contextInfo?.quotedMessage?.videoMessage, d.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage].filter(Boolean);
  return c.find(a => a.URL || a.url || a.mediaKey) || null;
}
function normalizeVideoMessage(v) {
  if (!v || typeof v !== 'object') return null;
  return { ...v, url: v.url || v.URL, fileEncSha256: v.fileEncSha256 || v.fileEncSHA256, mimetype: v.mimetype || v.mimeType || 'video/mp4', mediaKey: v.mediaKey, directPath: v.directPath };
}
async function downloadVideoBuffer(video) {
  const n = normalizeVideoMessage(video);
  if (!n?.url) { log('[video] download: sem url'); return null; }
  if (!n.mediaKey && /^https?:\/\//i.test(String(n.url))) {
    try {
      const { data } = await axios.get(n.url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
      return { buffer: Buffer.from(data), mimetype: n.mimetype || 'video/mp4' };
    } catch (e) { stats.errors++; log('[video] download direto falhou:', e.response?.status || e.message); return null; }
  }
  if (!n.mediaKey) { log('[video] mediaKey ausente e url nao http'); return null; }
  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(n, 'video');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), mimetype: n.mimetype || 'video/mp4' };
}
async function describeVideo(video) {
  const media = await downloadVideoBuffer(video);
  if (!media?.buffer?.length) return null;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mp4 = `/tmp/vid-${stamp}.mp4`, ogg = `/tmp/vid-${stamp}.ogg`, jpg = `/tmp/vid-${stamp}.jpg`;
  let fala = '', cena = '';
  try {
    fs.writeFileSync(mp4, media.buffer);
    // áudio do vídeo -> Groq Whisper (a fala é o conteúdo principal de um reels)
    if (await runFfmpeg(['-y', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', '-t', '300', ogg]) && fs.existsSync(ogg) && fs.statSync(ogg).size > 1000) {
      fala = (await transcribeViaGroq({ buffer: fs.readFileSync(ogg), mimetype: 'audio/ogg' })) || '';
    }
    // 1 frame (1s) -> visão Gemini (cenário, texto na tela)
    if (await runFfmpeg(['-y', '-ss', '1', '-i', mp4, '-frames:v', '1', '-vf', 'scale=720:-1', jpg]) && fs.existsSync(jpg)) {
      cena = (await geminiVisionBuffer(fs.readFileSync(jpg), 'image/jpeg', 'Descreva objetivamente, em português, este FRAME de um vídeo: pessoa, cenário e QUALQUER texto/legenda na tela. Conciso, sem inventar.')) || '';
    }
  } catch (e) { log('[video] processamento falhou:', e.message); }
  finally { for (const f of [mp4, ogg, jpg]) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} } }
  if (!fala && !cena) return null;
  if (fala) log(`[video] fala -> ${fala.slice(0, 80)}`);
  return { fala, cena };
}
async function enrichTextWithVideo(data, text) {
  const video = findVideoMessage(data);
  if (!video) return text;
  const caption = String(video.caption || video.Caption || '').trim();
  const base = String(text || '').trim();
  const r = await describeVideo(video);
  if (!r) {
    return `${base ? base + '\n\n' : ''}[Vídeo recebido, mas não consegui abrir agora. Diga com franqueza que não conseguiu ver e peça pra reenviar ou resumir — NUNCA finja que viu.]${caption ? '\nLegenda: ' + caption : ''}`;
  }
  const partes = [];
  if (r.fala) partes.push(`O que é FALADO no vídeo (transcrição): ${r.fala}`);
  if (r.cena) partes.push(`O que APARECE (1 frame): ${r.cena}`);
  return `${base ? base + '\n\n' : ''}[A pessoa mandou um VÍDEO. Use o conteúdo real abaixo pra responder de verdade — NÃO finja, trabalhe em cima disto:]\n${partes.join('\n')}${caption ? '\nLegenda escrita pela pessoa: ' + caption : ''}`;
}

// ---------- deduplicação (webhook + SSE não duplicam) ----------
const seen = new Map(); // msgId -> timestamp
const SEEN_TTL = 5 * 60 * 1000;
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  return false;
}
setInterval(() => {
  const cut = Date.now() - SEEN_TTL;
  for (const [k, t] of seen) if (t < cut) seen.delete(k);
}, 60 * 1000).unref();

// ---------- diretivas <uazapi> (porta da Leona) ----------
function normalizeBlock(obj) {
  if (!obj || typeof obj !== 'object') return { kind: 'unknown', payload: obj };
  if (typeof obj.action === 'string') return { kind: 'action', payload: obj };
  // áudio: {type:'send.audio'|'audio'|'ptt'|'voice', url|file, ptt?:bool, mimetype?, caption?, delay?}
  if (typeof obj.type === 'string' && /^(send\.audio|audio|ptt|voice|send\.ptt)$/i.test(obj.type)) {
    const url = obj.url || obj.file;
    if (url) {
      const ptt = obj.ptt === true || /ptt|voice/i.test(obj.type);
      return { kind: 'audio', payload: { ...obj, url, ptt } };
    }
  }
  if (typeof obj.type === 'string' && /^(chat|label|group|send|sender|mass|message|community)\./.test(obj.type) && !obj.choices) {
    const { type, ...rest } = obj;
    return { kind: 'action', payload: { action: type, ...rest } };
  }
  if (typeof obj.type === 'string' && ['button', 'buttons', 'list', 'poll', 'carousel'].includes(obj.type)) {
    if (obj.type === 'buttons') obj.type = 'button';
    return { kind: 'menu', payload: obj };
  }
  if (Array.isArray(obj.carousel)) {
    return { kind: 'menu', payload: obj };
  }
  return { kind: 'unknown', payload: obj };
}
function parseAgentReply(text) {
  const out = { parts: [], actions: [] };
  if (!text) return out;
  let cleaned = String(text).replace(/<uazapi-action>([\s\S]*?)<\/uazapi-action>/gi, (_m, body) => {
    try { out.actions.push(JSON.parse(body.trim())); } catch { log('[warn] bad uazapi-action JSON'); }
    return '';
  });
  // limpa artefatos internos que vazam do agente
  cleaned = cleaned.replace(/\[\[reply_to_current\]\]/gi, '').replace(/\[\[[a-z_]+\]\]/gi, '');
  const rx = /<uazapi>([\s\S]*?)<\/uazapi>/gi;
  let last = 0, m;
  while ((m = rx.exec(cleaned)) !== null) {
    const before = cleaned.slice(last, m.index).trim();
    if (before) out.parts.push(before);
    try {
      const obj = JSON.parse(m[1].trim());
      const norm = normalizeBlock(obj);
      if (norm.kind === 'action') out.actions.push(norm.payload);
      else if (norm.kind === 'menu' || norm.kind === 'audio') out.parts.push(norm.payload);
      else out.parts.push(obj);
    } catch { out.parts.push(m[0]); }
    last = m.index + m[0].length;
  }
  const tail = cleaned.slice(last).trim();
  if (tail) out.parts.push(tail);
  if (out.parts.length === 0 && cleaned.trim()) out.parts.push(cleaned.trim());
  return out;
}

// ---------- chunking humano ----------
const MAX_CHUNKS = 6;
function humanChunks(text) {
  const clean = String(text).trim();
  if (!clean) return [];
  const blocks = clean.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (blocks.length <= MAX_CHUNKS) return blocks;
  // não corta: agrupa o excedente na última mensagem (preserva 100% do conteúdo)
  const head = blocks.slice(0, MAX_CHUNKS - 1);
  head.push(blocks.slice(MAX_CHUNKS - 1).join('\n\n'));
  return head;
}

// ---------- envio uazapi ----------
function uaz(inst) {
  return axios.create({
    baseURL: inst.uazapi_url,
    headers: { token: inst.uazapi_token, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}
// envia texto e devolve o id da mensagem (pra poder editar depois)
async function sendTextReturningId(inst, chatid, text, replyid) {
  try {
    const { data } = await uaz(inst).post('/send/text', { number: chatid, text, ...(replyid ? { replyid } : {}) });
    const d = Array.isArray(data) ? data[0] : data;
    return d?.id || d?.messageid || d?.key?.id || d?.message?.id || null;
  } catch (e) {
    log(`[${inst.id}] sendTextReturningId erro:`, e.response?.status || e.message);
    return null;
  }
}
async function editMsg(inst, id, text) {
  if (!id) return false;
  try { await uaz(inst).post('/message/edit', { id, text }); return true; }
  catch (e) { return false; }
}
async function setPresence(inst, chatid, presence) {
  try { await uaz(inst).post('/message/presence', { number: chatid, presence }); } catch {}
}
// abertura + frases criativas (com emoji) que mascaram a espera, como pensando junto
const THINK_OPENERS = [
  '🧠 deixa eu pensar nisso com o cafezinho na mão...',
  '👔 vestindo o terno mental, já te resolvo...',
  '📋 abrindo seu caso aqui na minha mesa...',
  '🚀 bora, vou botar a equipe pra rodar...',
  '🙋‍♀️ assumindo essa demanda agora mesmo...',
  '🗃️ puxando sua pasta no arquivo (digital)...',
];
// "Pensando" = a funcionária dando SATISFAÇÃO de que está fazendo (e ainda não acabou),
// charmosa, sempre com um impeditivo/desculpa — e, quando cabe, a pegada ácida
// "antes isso era manual e demorado; comigo é na hora". NUNCA fato solto fora do tema.
const THINK_PHRASES = [
  // — desculpas charmosas (uma linha) —
  'Calma que já tô quase… só passando o pente fino ✨',
  'Tô indo o mais rápido que o capricho deixa 🏃‍♀️',
  'Pera que perfeição não tem atalho — mas eu tenho pressa 😌',
  'Já já! Tô só amarrando as pontas soltas 🎀',
  'Segura um tiquinho — quero te dar o "uau", não o "ok" 💫',
  'Tô resolvendo nos bastidores, já já te mostro o show 🎭',
  'Quase! Prometo que vale o segundinho a mais ⏱️',
  'Tô terminando — é dedicação, não demora 💪',
  'Pera que eu odeio entregar pela metade 🙅‍♀️',
  'Já tô voltando — fui buscar a melhor versão disso 🚀',
  'Mais um respiro que tá ficando lindo 😮‍💨',
  'Tô no capricho fino: aquele que se sente, não se vê ✨',
  'Calma calma… deixa eu tirar do forno na hora certa 🔥',
  'Conferindo duas vezes pra você não conferir nenhuma 🤓',
  'Tô deixando do seu jeito, não do jeito qualquer 😌',
  'Mais um instante que eu te entrego isso redondo 🟢',
  // — desculpas com formatação avançada + pegada ácida (manual vs agora) —
  `*Calma que já tô quase…* ⏳\n> antigamente isso levava o dia todo. me dá 5 segundinhos 😌`,
  `*Tô caprichando, não enrolando* 💎\n> prefiro certo e bonito a rápido e torto 😉`,
  `*O que 3 pessoas faziam num dia…* 😵‍💫\n> eu faço agora — só respira que já sai ⚡`,
  `*Antes era "te retorno semana que vem"* 📆\n> comigo é "te retorno em instantes" ⏱️`,
  `*Não travei — tô pensando* 🧠\n> o sistema velho que travava; eu só capricho`,
  `*Era pra ser demorado e chato* 🥱\n> deixei só a parte boa. quase pronto ✨`,
  `*Tô fazendo de tudo ao mesmo tempo* 🤹\n> e nada disso é te deixar no vácuo, juro`,
  `*Segura aí que vale a pena* 💛\n> coisa boa não sai no susto, sai no capricho`,
  `*Já no finalzinho* 🤏\n> dando aquele tapa final que faz diferença 🎨`,
  `*Aquilo que era planilha + caderno + reza* 📒\n> virou uns segundinhos meus. peraí 😌`,
  `*Quase, quase!* 🙏\n> a pressa é inimiga do "uau" — e eu quero o teu`,
  `*Tô amarrando os detalhes* 🎀\n> é o capricho que ninguém vê, mas todo mundo sente ✨`,
  `*Pera que eu acerto de primeira* 🎯\n> refazer é que tomaria seu tempo — esse eu poupo`,
  `*Tô puxando tudo pra você* 📋\n> sem caderninho, sem fila, sem "amanhã eu vejo" 🙌`,
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// sorteio "saco embaralhado": não repete até esgotar a lista inteira -> randomização máxima
function bagPicker(arr) {
  let bag = [];
  return () => {
    if (!bag.length) bag = [...arr].sort(() => Math.random() - 0.5);
    return bag.pop();
  };
}
const nextThinkOpener = bagPicker(THINK_OPENERS);
const nextThinkPhrase = bagPicker(THINK_PHRASES);

// ---- Tier 0: reflexo de saudação (resposta instantânea, SEM cérebro, SEM loading) ----
const SAUDACOES = new Set([
  'oi', 'ola', 'opa', 'eai', 'e ai', 'alo', 'hello', 'hi', 'hey', 'salve', 'fala', 'iae', 'yo',
  'bom dia', 'boa tarde', 'boa noite', 'boa', 'tudo bem', 'tudo bom', 'td bem', 'blz', 'beleza',
  'oi sofia', 'ola sofia', 'oi tudo bem', 'oi tudo bom', 'ta ai', 'vc ta ai', 'voce esta ai',
  'oi bom dia', 'oi boa tarde', 'oi boa noite',
]);
function isSaudacao(text) {
  const t = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // tira acento
    .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim(); // tira emoji/pontuação
  if (!t || t.length > 22) return false;                 // saudação é sempre curta
  if (/^(o+i+e*|ol+a+|op+a+|e* *a+i+|al+o+|hel+o+|hi+|hey+|yo)$/.test(t)) return true; // oi/oii/oie/olá/eaí...
  return SAUDACOES.has(t);
}
const SAUDACOES_BASE = [
  'Oi{nome}! 👋 Aqui é a *Sofia*, da Empresa.ia. Me conta, o que tá pegando hoje?',
  'Opa{nome}, tudo bem? 😊 Sou a *Sofia*. Como posso te ajudar?',
  'Oi{nome}! Que bom te ver por aqui 🙌 Sou a *Sofia* — com quem eu falo?',
  'E aí{nome}, beleza? 😄 Aqui é a *Sofia*. Bora — me diz o que você quer resolver.',
  'Oii{nome}! 💛 Sou a *Sofia*, da Empresa.ia. O que te traz aqui hoje?',
  'Olá{nome}! 👋 *Sofia* na área. Me fala rapidinho o que você precisa.',
  'Oi{nome}! 😊 Sou a *Sofia*. Tô aqui pra te ajudar — por onde começamos?',
];
const SAUDACAO_TIP = '\n\n> 💡 manda *demo* pra ver um exemplo ao vivo · *@equipe* o time · *@ajuda* como funciona';
const nextSaudacaoBase = bagPicker(SAUDACOES_BASE);
function saudacaoInstantanea(nome) {
  const n = nome ? ` ${String(nome).split(' ')[0]}` : '';
  return nextSaudacaoBase().replace('{nome}', n) + SAUDACAO_TIP;
}
// Boas-vindas RICAS pra quem NÃO é o dono (lead/curioso): a experiência completa no 1º contato.
// texto caloroso (proposta de valor) + vitrine da equipe (fotos + "Falar com") + botão pra ver a DEMO ao vivo.
// É o que faz a pessoa pensar "isso não é um bot normal" sem precisar saber comando nenhum.
function boasVindasRico(chatid, nome) {
  const n = nome ? ` ${String(nome).split(' ')[0]}` : '';
  const intro =
    `Oi${n}! 👋 Aqui é a *Sofia*, da *Empresa.ia*.\n\n` +
    `A gente não é um chatbot — é um *time de funcionárias de IA* que vive aqui dentro do WhatsApp e toca o seu negócio com você: atendimento, vendas, conteúdo, agenda e financeiro, trabalhando *24h*. 💛\n\n` +
    `Deixa eu te apresentar quem trabalha com você 👇`;
  const verDemo = {
    type: 'button',
    text: '✨ E dá pra me ver *trabalhando ao vivo* agora — um atendimento de verdade, com os botões funcionando. Toca aqui 👇',
    choices: ['💆 Ver um atendimento ao vivo|demo_estetica', '👀 Ver outros exemplos|demo'],
  };
  return [intro, vitrineCarousel(chatid), verDemo];
}

// ---------- onboarding conversacional: conexão (nome -> nicho -> áudio personalizado) ----------
const SAUDACOES_CURTAS = ['Oi', 'Opa', 'Oii', 'Olá', 'E aí'];
const nextOiBag = bagPicker(SAUDACOES_CURTAS);
// passo 1: cumprimenta e pergunta o NOME (conexão antes de tudo)
function onboardPerguntaNome() {
  return `${nextOiBag()}! 👋 Aqui é a *Sofia*, da *Empresa.ia*.\n\nAntes de te mostrar tudo, deixa eu te conhecer 💛\nComo é o seu *nome*?`;
}
// passo 2: chama pelo nome e pergunta o NEGÓCIO/nicho
function onboardPerguntaNicho(nome) {
  const n = nome ? `, ${nome}` : '';
  return `Prazer${n}! 😄\n\nMe conta uma coisa: *o que você faz?* Qual é o seu negócio?\n_(ex.: clínica de estética, loja de roupa, restaurante, consultoria...)_`;
}
// limpa o que a pessoa digitou como nome (tira saudação/ruído em cadeia, pega o primeiro nome)
function extrairNome(text) {
  let t = String(text || '').replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const filler = /^(oi+|ol[aá]+|opa+|e+ a[ií]+|bom dia|boa tarde|boa noite|meu nome [eé]|meu nome|me chamo|chamo|sou [oa] |sou |aqui [eé] [oa] |aqui [eé] |[eé] |prazer|tudo bem|tudo bom)\s*/i;
  let prev;
  do { prev = t; t = t.replace(filler, '').trim(); } while (t !== prev && t);
  const primeiro = (t.split(' ').filter(Boolean)[0] || '').slice(0, 24);
  if (!primeiro) return '';
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}
// roteiro do áudio PERSONALIZADO: cita nome + negócio, mostra a transformação pro negócio dela.
// "venda sem vender": pinta o cenário, encanta, convida — sem pressão.
function roteiroPersonalizado(nome, negocio) {
  const n = nome || 'pessoa';
  const neg = String(negocio || 'seu negócio').trim().slice(0, 70);
  const t = neg.toLowerCase();
  let beneficio;
  if (/estetic|clinic|beleza|sa[uú]de|dent|spa|cabelo|sobrancelha|est[eé]tica/.test(t)) {
    beneficio = `Cliente te chama querendo agendar, e em vez de cair no vácuo a gente responde na hora, mostra os procedimentos e marca a avaliação. Quem some, a gente traz de volta.`;
  } else if (/loja|roupa|venda|comerci|boutique|moda|cal[cç]ado|acess[oó]rio|e-?commerce|ecommerce/.test(t)) {
    beneficio = `Chega gente perguntando preço e tamanho, e a resposta vem na hora, com foto, fechando a venda no WhatsApp. Quem botou no carrinho e sumiu, a gente chama de volta.`;
  } else if (/restaurant|comida|food|lanch|pizza|hamburg|delivery|bar|cafe|caf[eé]|gastr/.test(t)) {
    beneficio = `Pedido, cardápio, reserva — tudo respondido na hora e organizado, sem você largar a operação. E o cliente fiel recebe aquele empurrãozinho pra voltar.`;
  } else if (/consult|advog|contab|coach|mentor|servi[cç]o|ag[êe]ncia|infoproduto|curso|profission/.test(t)) {
    beneficio = `Cada interessado atendido na hora, qualificado, com a proposta certa — e o follow-up rolando sozinho com quem ainda não fechou. Nenhuma oportunidade esfria.`;
  } else {
    beneficio = `Cada pessoa que te procura é atendida na hora, fechando o que precisa — e quem some, a gente traz de volta, sem você levantar um dedo.`;
  }
  return (
    `Oi ${n}! Deixa eu te falar rapidinho, que eu acho que vai te animar. ` +
    `Então, você toca ${neg}, né? Olha que bom: ${beneficio} ` +
    `E o melhor: não é você grudado no celular o dia inteiro. Eu e meu time vivemos aqui dentro do seu WhatsApp, trabalhando vinte e quatro horas, sem férias, sem esquecer de nada. ` +
    `Não é robozinho de 'digite um, digite dois', não — é um time de verdade cuidando do seu negócio com você. ` +
    `${n}, que tal eu te mostrar funcionando agora, em uns segundinhos?`
  );
}
const ESTILO_LEAD = 'Fale como uma brasileira carismática, calorosa e empolgada, com energia contagiante e um quê de provocação — ritmo de conversa real, com pausas pra dar ênfase, nada de locução robótica: ';
// entrega o ÁUDIO personalizado: mostra "gravando áudio...", gera o TTS na hora (mascarado pela presença),
// manda o PTT (ou texto, se o TTS falhar) e revela a equipe + a demo. É o momento "encanta".
async function onboardEntregaAudio(inst, chatid, nome, negocio) {
  const roteiro = roteiroPersonalizado(nome, negocio);
  // "gravando áudio..." (persiste enquanto o TTS é gerado — mascara a espera, fica natural)
  try { await uaz(inst).post('/message/presence', { number: chatid, presence: 'recording', delay: 35000 }); } catch {}
  const file = await gerarAudioTTS(`lead-${onlyDigits(chatid) || 'x'}`, roteiro, ESTILO_LEAD);
  if (file) {
    await sendPart(inst, chatid, { type: 'ptt', url: assetUrl(file), delay: 600 });
  } else {
    // fallback à prova de falha: manda o mesmo conteúdo em texto, sem deixar o lead no vácuo
    await sendText(inst, chatid, roteiro);
  }
  // revelação: a equipe (fotos + "Falar com") + botão pra ver ao vivo
  await sendPart(inst, chatid, vitrineCarousel(chatid));
  await sendPart(inst, chatid, {
    type: 'button',
    text: '✨ Toca aqui que eu te mostro um atendimento *de verdade*, ao vivo 👇',
    choices: ['💆 Ver um atendimento ao vivo|demo_estetica', '👀 Ver outros exemplos|demo'],
  });
}

async function sendText(inst, chatid, text, replyid) {
  const chunks = humanChunks(text);
  let ok = 0;
  for (let i = 0; i < chunks.length; i++) {
    const delay = Math.min(2500, 600 + chunks[i].length * 25);
    const payload = { number: chatid, text: chunks[i], delay, ...(i === 0 && replyid ? { replyid } : {}) };
    // 1 retry com backoff: sem isso, um 5xx/timeout transitório DESCARTA a resposta do agente
    // em silêncio e o cliente fica no vácuo achando que foi ignorado.
    let sent = false;
    for (let tent = 0; tent < 2 && !sent; tent++) {
      try {
        if (tent) await sleep(1200);
        // só a PRIMEIRA mensagem cita (quota) a mensagem da pessoa
        await uaz(inst).post('/send/text', payload);
        ok++; sent = true;
      } catch (e) {
        stats.errors++;
        log(`[${inst.id}] send/text erro (tentativa ${tent + 1}/2):`, e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 200));
      }
    }
    if (i < chunks.length - 1) await sleep(400 + Math.random() * 600);
  }
  return ok;
}

function wavoip() {
  return axios.create({
    baseURL: process.env.WAVOIP_BASE_URL || WAVOIP_BASE_URL,
    headers: { Authorization: `Bearer ${process.env.WAVOIP_API_KEY || WAVOIP_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: parseInt(process.env.WAVOIP_TIMEOUT_MS || String(WAVOIP_TIMEOUT_MS), 10),
  });
}

let wavoDevice = null;

function wavoDeviceBaseUrl() {
  return String(process.env.WAVOIP_DEVICE_URL || WAVOIP_DEVICE_URL).replace(/\/+$/, '');
}

function wavoDeviceToken() {
  return process.env.WAVOIP_DEVICE_TOKEN || process.env.WAVOIP_API_KEY || WAVOIP_API_KEY;
}

function wavoTimeoutMs() {
  return parseInt(process.env.WAVOIP_TIMEOUT_MS || String(WAVOIP_TIMEOUT_MS), 10);
}

function createWavoDevice(token) {
  const baseUrl = wavoDeviceBaseUrl();
  const socket = io(baseUrl, {
    transports: ['websocket'],
    path: `/${token}/websocket`,
    autoConnect: false,
    auth: { version: 'official' },
    reconnection: true,
    reconnectionAttempts: 3,
  });
  const device = {
    token,
    socket,
    status: 'disconnected',
    connected: false,
    readyPromise: null,
  };

  socket.on('device:status', status => {
    device.status = status || 'unknown';
    log(`[wavoip] device status: ${device.status}`);
  });
  socket.on('connect', () => {
    device.connected = true;
    log('[wavoip] device socket conectado');
  });
  socket.on('disconnect', () => {
    device.connected = false;
    device.status = 'disconnected';
    log('[wavoip] device socket desconectado');
  });

  return device;
}

async function ensureWavoDevice() {
  const token = wavoDeviceToken();
  if (!token) throw new Error('WAVOIP_API_KEY ausente');
  if (!wavoDevice || wavoDevice.token !== token) {
    if (wavoDevice?.socket) wavoDevice.socket.close();
    wavoDevice = createWavoDevice(token);
  }
  if (wavoDevice.status === 'open' && wavoDevice.connected) return wavoDevice;
  if (!wavoDevice.readyPromise) {
    const timeout = Math.min(wavoTimeoutMs(), 12000);
    wavoDevice.readyPromise = Promise.race([
      axios.get(`${wavoDeviceBaseUrl()}/${token}/whatsapp/all_info`, { timeout }).then(({ data }) => {
        const status = data?.result?.status || data?.status || wavoDevice.status;
        wavoDevice.status = status || 'unknown';
        if (!wavoDevice.connected) wavoDevice.socket.connect();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`dispositivo indisponivel: ${wavoDevice.status || 'sem status'}`));
          }, timeout);
          const cleanup = () => {
            clearTimeout(timer);
            wavoDevice.socket.off('device:status', onStatus);
            wavoDevice.socket.off('connect', onConnect);
            wavoDevice.socket.off('connect_error', onError);
          };
          const maybeReady = () => {
            if (wavoDevice.status === 'open' && wavoDevice.connected) {
              cleanup();
              resolve(wavoDevice);
            }
          };
          const onStatus = statusValue => {
            wavoDevice.status = statusValue || wavoDevice.status;
            maybeReady();
          };
          const onConnect = () => {
            wavoDevice.connected = true;
            maybeReady();
          };
          const onError = error => {
            cleanup();
            reject(error);
          };
          wavoDevice.socket.on('device:status', onStatus);
          wavoDevice.socket.on('connect', onConnect);
          wavoDevice.socket.on('connect_error', onError);
          maybeReady();
        });
      }),
    ]).finally(() => { wavoDevice.readyPromise = null; });
  }
  return wavoDevice.readyPromise;
}

async function startWavoDeviceCall(payload) {
  const device = await ensureWavoDevice();
  const to = payload.to || payload.phone;
  if (!to) throw new Error('telefone do chat invalido');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ao iniciar chamada')), Math.min(wavoTimeoutMs(), 15000));
    device.socket.emit('call:start', to, response => {
      clearTimeout(timer);
      if (response?.type === 'error') return reject(new Error(String(response.result || 'chamada recusada')));
      resolve({ ok: true, provider: 'wavoip-device', call: response?.result || response || null });
    });
  });
}

function phoneForCall(chatid) {
  const digits = onlyDigits(chatid);
  return digits ? `+${digits}` : '';
}

function employeeCallPrompt(employee) {
  return [
    `Voce e ${employee.name}, funcionario virtual da Empresa.ia no setor ${employee.role}.`,
    'Voce nao e atendente generico: voce liga porque percebeu um sinal operacional que merece acao agora.',
    `Sua missao nesta chamada: ${employee.mission}.`,
    `Solucao que voce representa: ${employee.solution}`,
    `Insight inicial: ${employee.insight}`,
    'Conduza a ligacao em portugues do Brasil, com tom consultivo, direto e executivo.',
    'Fluxo da ligacao:',
    '1. Apresente-se em uma frase e diga por que esta ligando.',
    '2. Confirme se a pessoa tem 2 minutos.',
    '3. Traga o diagnostico provavel sem inventar dado nao conectado.',
    '4. Proponha uma unica acao concreta para destravar o setor.',
    '5. Pergunte se deve preparar o proximo passo no WhatsApp.',
    '6. Se faltar fonte real, diga exatamente qual fonte precisa conectar.',
    'Nunca finja acesso a dados que nao foram fornecidos. Seja proativo sem ser invasivo.',
  ].join('\n');
}

function employeeVariables(employee, chatid, data, triggerText) {
  return {
    employee_id: employee.id,
    employee_name: employee.name,
    employee_role: employee.role,
    employee_badge: employee.badge,
    employee_sector: employee.category,
    mission: employee.mission,
    solution: employee.solution,
    insight: employee.insight,
    dynamic_prompt: employeeCallPrompt(employee),
    trigger_text: String(triggerText || ''),
    whatsapp_chatid: String(chatid || ''),
    customer_phone: phoneForCall(chatid),
    customer_name: senderName(data) || 'Saraiva',
    source: 'empresaia_whatsapp_carousel',
  };
}

// ---------- ligação pela NOSSA stack (LiveKit + voz-agente) ----------
function lkRun(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.env.LK_BIN || '/usr/local/bin/lk', args, { env: process.env });
    let so = '', se = '';
    const killer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 30000);
    c.stdout.on('data', d => so += d);
    c.stderr.on('data', d => se += d);
    c.on('error', (e) => { clearTimeout(killer); reject(e); });
    c.on('close', (code) => { clearTimeout(killer); code === 0 ? resolve(so) : reject(new Error(`lk ${args.slice(0,2).join(' ')} exit ${code}: ${(se || so).slice(-300)}`)); });
  });
}

async function makeLiveKitCall(employee, chatid, data, triggerText) {
  const phone = phoneForCall(chatid);
  if (!phone) throw new Error('telefone do chat invalido');
  const trunk = process.env.VOZ_SIP_TRUNK || '';
  if (!trunk) throw new Error('VOZ_SIP_TRUNK ausente');
  const rand = Math.random().toString(36).slice(2, 8);
  const room = `call-${employee.id}-${onlyDigits(phone)}-${rand}`; // persona + número embutidos no nome
  const meta = JSON.stringify({ employee_id: employee.id, to: onlyDigits(phone), customer_name: senderName(data) || '' });
  await lkRun(['room', 'create', room]).catch(() => {});
  await lkRun(['room', 'update', '--metadata', meta, room]).catch(() => {});
  const out = await lkRun(['sip', 'participant', 'create', '--trunk', trunk, '--call', phone, '--room', room, '--identity', 'caller', '--name', `${employee.name} Empresa.ia`]);
  log(`[livekit] call ${employee.id} -> ${phone} room=${room}`);
  return { ok: true, via: 'livekit', room, detail: out.slice(0, 160) };
}

async function makeEmployeeCall(employee, chatid, data, triggerText) {
  const mode = (process.env.VOZ_CALL_MODE || 'livekit').toLowerCase();
  if (mode === 'livekit') {
    try { return await makeLiveKitCall(employee, chatid, data, triggerText); }
    catch (e) { log(`[call] livekit falhou (${e.message}); fallback autocalls`); }
  }
  return makeAutoCall(phoneForCall(chatid), employeeVariables(employee, chatid, data, triggerText));
}

function employeeWavoCallPayload(employee, chatid, data, triggerText) {
  const phone = phoneForCall(chatid);
  if (!phone) throw new Error('telefone do chat invalido');
  const variables = employeeVariables(employee, chatid, data, triggerText);
  return {
    to: phone,
    phone,
    number: onlyDigits(phone),
    channel: 'whatsapp',
    source: 'empresaia_whatsapp_carousel',
    employee_id: employee.id,
    employee_name: employee.name,
    whatsapp_chatid: String(chatid || ''),
    variables,
    dynamic_variables: variables,
    conversation_initiation_client_data: { dynamic_variables: variables },
  };
}

function autocallsBase() {
  let b = (process.env.AUTOCALLS_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!b) b = 'https://api.autocalls.ai/api';
  b = b.replace('://app.autocalls.ai', '://api.autocalls.ai');
  if (!/\/api(\/|$)/.test(b)) b += '/api';
  return b;
}
async function makeAutoCall(phone, variables) {
  const key = process.env.AUTOCALLS_API_KEY || '';
  const assistantId = parseInt(process.env.AUTOCALLS_ASSISTANT_ID || '0', 10);
  if (!key) throw new Error('AUTOCALLS_API_KEY ausente');
  if (!assistantId) throw new Error('AUTOCALLS_ASSISTANT_ID ausente');
  if (!phone) throw new Error('telefone do chat invalido');
  const { data } = await axios.post(`${autocallsBase()}/user/make_call`, {
    phone_number: phone,
    assistant_id: assistantId,
    variables: variables || {},
  }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000 });
  log(`[autocalls] make_call -> ${phone} (assistant ${assistantId}): ${JSON.stringify(data).slice(0, 160)}`);
  return data;
}

async function makeEmployeeWavoCall(employee, chatid, data, triggerText) {
  const baseUrl = process.env.WAVOIP_BASE_URL || WAVOIP_BASE_URL;
  const apiKey = process.env.WAVOIP_API_KEY || WAVOIP_API_KEY;
  const endpoint = process.env.WAVOIP_CALL_ENDPOINT || WAVOIP_CALL_ENDPOINT;
  if (!apiKey) {
    throw new Error('WAVOIP_API_KEY ausente');
  }
  const payload = {
    ...employeeWavoCallPayload(employee, chatid, data, triggerText),
  };
  if (!baseUrl) return startWavoDeviceCall(payload);
  if (!endpoint) throw new Error('WAVOIP_CALL_ENDPOINT ausente');
  const { data: response } = await wavoip().post(endpoint, payload);
  return response;
}

function objectAt(...items) {
  return items.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function extractAutoCallsContext(payload) {
  const input = objectAt(payload.input_variables, payload.inputVariables, payload.variables, payload.data?.input_variables, payload.data?.variables, payload.lead?.variables);
  const extracted = objectAt(payload.extracted_variables, payload.extractedVariables, payload.data?.extracted_variables);
  const employee = employeesById.get(String(input.employee_id || '').toLowerCase()) || null;
  const transcript = payload.formatted_transcript || payload.formattedTranscript || (Array.isArray(payload.transcript)
    ? payload.transcript.map(item => `${item.sender || item.role || 'fala'}: ${item.text || item.content || ''}`).join('\n')
    : String(payload.transcript || ''));
  return { input, extracted, employee, transcript };
}

async function handleAutoCallsWebhook(payload) {
  const { input, extracted, employee, transcript } = extractAutoCallsContext(payload);
  const chatid = input.whatsapp_chatid;
  if (!chatid) {
    log('[autocalls] post-call sem whatsapp_chatid');
    return 0;
  }
  const inst = CFG[0];
  const name = employee?.name || input.employee_name || 'Funcionario Empresa.ia';
  const status = payload.status || payload.data?.status || 'finalizada';
  const achieved = extracted.status === true ? 'sim' : extracted.status === false ? 'nao' : 'nao informado';
  const summary = extracted.summary || payload.summary || 'Resumo ainda nao veio no webhook.';
  const duration = payload.duration ? `${payload.duration}s` : 'nao informado';
  const snippet = transcript ? `\n\n*Trecho*\n${String(transcript).slice(0, 650)}` : '';
  const text = `*Ligacao finalizada — ${name}*\n━━━━━━━━━━━━\nStatus: ${status}\nObjetivo atingido: ${achieved}\nDuracao: ${duration}\n\n*Resumo*\n${summary}${snippet}`;
  await sendText(inst, chatid, text);
  const followup = employee ? employeeDetailCarousel(employee.id, chatid) : empresaHomeCarousel(chatid);
  await sendPart(inst, chatid, followup);
  stats.postCalls++; stats.lastPostCallAt = new Date().toISOString();
  return 1;
}

async function handleAutoCallsTool(payload) {
  const input = objectAt(payload.input_variables, payload.inputVariables, payload.variables, payload.data?.input_variables, payload.data?.variables);
  const employeeId = String(payload.employee_id || input.employee_id || payload.sector_employee_id || '').toLowerCase();
  const employee = employeesById.get(employeeId) || null;
  const name = employee?.name || payload.employee_name || input.employee_name || 'Empresa.ia';
  const role = employee?.role || payload.employee_role || input.employee_role || 'setor inteligente';
  const intent = String(payload.intent || payload.acao || payload.action || 'orientar_proximo_passo');
  const finding = String(payload.finding || payload.diagnostico || payload.insight || employee?.insight || 'Sinal operacional identificado durante a ligacao.');
  const nextStep = String(payload.next_step || payload.proximo_passo || payload.recommendation || employee?.mission || 'confirmar a fonte de dados e preparar o proximo passo no WhatsApp');
  const urgency = Number(payload.urgency || payload.prioridade || 6);
  const chatid = input.whatsapp_chatid || payload.whatsapp_chatid || '';
  const whatsappMessage = String(payload.whatsapp_message || payload.message || '').trim();
  const shouldSend = ['send_whatsapp', 'enviar_whatsapp', 'registrar_e_enviar'].includes(intent);

  let whatsapp_status = 'not_requested';
  if (shouldSend && chatid && whatsappMessage) {
    try {
      await sendText(CFG[0], chatid, whatsappMessage);
      whatsapp_status = 'sent';
    } catch (e) {
      stats.errors++;
      whatsapp_status = `failed: ${e.message}`;
    }
  }

  return {
    ok: true,
    employee_id: employee?.id || employeeId || null,
    employee_name: name,
    employee_role: role,
    intent,
    urgency: Number.isFinite(urgency) ? Math.max(1, Math.min(10, urgency)) : 6,
    finding,
    next_step: nextStep,
    whatsapp_status,
    voice_guidance: [
      `Diga que ${name} encontrou um sinal em ${role}.`,
      `Explique o diagnostico em uma frase: ${finding}`,
      `Peça permissao para preparar no WhatsApp: ${nextStep}.`,
      'Se a pessoa nao confirmar, encerre com respeito e prometa nao executar a acao.',
    ].join(' '),
  };
}

function parseChoiceButton(choice) {
  const [label, id] = String(choice || '').split('|');
  const text = label.trim();
  if (!text) return null;
  return { id: (id || text).trim(), text, type: 'REPLY' };
}

function legacyCarouselToStructured(part) {
  if (!part || part.type !== 'carousel' || !Array.isArray(part.choices)) return part;
  const cards = [];
  let current = null;
  for (const raw of part.choices) {
    const choice = String(raw || '').trim();
    const title = choice.match(/^\[(.+)\]$/);
    const image = choice.match(/^\{(.+)\}$/);
    if (title) {
      current = { text: title[1].trim(), buttons: [] };
      cards.push(current);
    } else if (image && current) {
      current.image = image[1].trim();
    } else if (current) {
      const button = parseChoiceButton(choice);
      if (button && current.buttons.length < 3) current.buttons.push(button);
    }
  }
  if (!cards.length) return part;
  return {
    text: part.text || '',
    carousel: cards.map(card => ({
      text: card.text,
      image: card.image || `${ASSET_BASE}apps-criativo.jpg`,
      buttons: card.buttons,
    })),
    readchat: part.readchat ?? true,
    delay: part.delay ?? 0,
  };
}

async function sendPart(inst, chatid, part, replyid) {
  if (typeof part === 'string') return sendText(inst, chatid, part, replyid);
  part = legacyCarouselToStructured(part);
  if (part && Array.isArray(part.carousel)) {
    try {
      await uaz(inst).post('/send/carousel', { number: chatid, ...part, ...(replyid ? { replyid } : {}) }, { timeout: 90000 });
      log(`[${inst.id}] carousel/structured -> ${chatid}`);
      return 1;
    } catch (e) {
      stats.errors++;
      log(`[${inst.id}] send/carousel erro:`, e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 200));
    }
  }
  if (part && isAudioPart(part)) {
    return sendAudio(inst, chatid, part);
  }
  if (part && part.type) {
    try {
      await uaz(inst).post('/send/menu', { number: chatid, ...part, ...(replyid ? { replyid } : {}) }, { timeout: 90000 });
      log(`[${inst.id}] menu/${part.type} -> ${chatid}`);
      return 1;
    } catch (e) {
      stats.errors++;
      log(`[${inst.id}] send/menu erro:`, e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 200));
    }
  }
  return 0;
}
function isAudioPart(part) {
  return part && typeof part === 'object' && typeof part.type === 'string'
    && /^(send\.audio|audio|ptt|voice|send\.ptt)$/i.test(part.type)
    && (part.url || part.file);
}
async function sendAudio(inst, chatid, part) {
  const url = part.url || part.file;
  if (!url) return 0;
  // só URLs http(s) ou base64 data-uri
  if (!/^https?:\/\//i.test(url) && !/^data:audio\//i.test(url)) {
    log(`[${inst.id}] send/audio bloqueado: url nao confiavel`);
    return 0;
  }
  const mediaType = (part.ptt === true || /ptt|voice/i.test(part.type)) ? 'ptt' : 'audio';
  const payload = {
    number: chatid,
    type: mediaType,
    file: url,
    delay: typeof part.delay === 'number' ? part.delay : 1000,
  };
  if (part.mimetype) payload.mimetype = part.mimetype;
  if (part.caption || part.text) payload.text = part.caption || part.text;
  try {
    await uaz(inst).post('/send/media', payload, { timeout: 90000 });
    log(`[${inst.id}] media/${mediaType} -> ${chatid}`);
    return 1;
  } catch (e) {
    stats.errors++;
    log(`[${inst.id}] send/audio erro:`, e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 200));
    return 0;
  }
}
function isInteractivePart(part) {
  return part && typeof part === 'object' && (Array.isArray(part.carousel) || ['button', 'buttons', 'list', 'poll', 'carousel'].includes(part.type));
}

const carouselAssets = {
  empresa: 'apps-estrategia.jpg',
  crm: 'apps-comercial.jpg',
  instagram: 'apps-criativo.jpg',
  meta: 'apps-marketing.jpg',
  google: 'apps-financeiro.jpg',
  whatsapp: 'apps-atendimento.jpg',
  automacoes: 'apps-tecnologia.jpg',
  conteudo: 'apps-criativo.jpg',
  marketing: 'apps-marketing.jpg',
  criativo: 'apps-criativo.jpg',
  projetos: 'apps-projetos.jpg',
  estrategia: 'apps-estrategia.jpg',
  financeiro: 'apps-financeiro.jpg',
  tecnologia: 'apps-tecnologia.jpg',
  atendimento: 'apps-atendimento.jpg',
  operacoes: 'apps-operacoes.jpg',
  rh: 'apps-rh.jpg',
  comercial: 'apps-comercial.jpg',
};

const employeeFallbackAssets = {
  crm: carouselAssets.comercial,
  financeiro: carouselAssets.financeiro,
  atendimento: carouselAssets.atendimento,
  agenda: carouselAssets.projetos,
  marketing: carouselAssets.marketing,
  ads: carouselAssets.marketing,
  vendas: carouselAssets.comercial,
  juridico: carouselAssets.estrategia,
  rh: carouselAssets.rh,
  estrategia: carouselAssets.estrategia,
  operacao: carouselAssets.operacoes,
  conteudo: carouselAssets.criativo,
  suporte: carouselAssets.atendimento,
  dados: carouselAssets.financeiro,
  automacoes: carouselAssets.tecnologia,
  cx: carouselAssets.atendimento,
  conversao: carouselAssets.tecnologia,
  reputacao: carouselAssets.marketing,
  produto: carouselAssets.estrategia,
  comunidade: carouselAssets.criativo,
  criativos: carouselAssets.criativo,
  rotina: carouselAssets.projetos,
  prioridade: carouselAssets.estrategia,
};

const employees = [
  ['sofia', 'Sofia', 'Gerente', 'cx', 'GERENTE', 'Sua empresa inteira em uma conversa: você manda a mensagem, eu aciono a especialista certa e te devolvo tudo resolvido — sem você gerenciar nada.', 'Oi! Pode mandar do jeito que vier: áudio, desabafo, lista. Eu organizo e trago quem resolve. Você não carrega mais isso sozinho.', 'te receber e organizar por onde comecar'],
  ['bia', 'Bia', 'Redes Sociais', 'conteudo', 'REDES SOCIAIS', 'Mantém seu Instagram vivo todo dia — post, comentário e DM respondidos — enquanto você toca o negócio em vez de morar no feed.', 'Sou a Bia! Sabe o comentário que ficou sem resposta? Eu vi. Deixa as redes comigo que sua audiência nunca mais fala sozinha. ✨', 'transformar audiencia em conversa e conteudo'],
  ['clara', 'Clara', 'Vendas', 'crm', 'VENDAS', 'Resgata proposta parada e te mostra quem está quente pra fechar — aquele dinheiro esquecido na conversa volta pra mesa.', 'Tem venda dormindo no seu WhatsApp agora mesmo. Deixa comigo: eu acordo essas conversas e te digo quem tá pronto pro sim.', 'recuperar receita parada antes de esfriar'],
  ['maya', 'Maya', 'Atendimento', 'atendimento', 'ATENDIMENTO', 'Acaba com o cliente no vácuo: a fila do WhatsApp em ordem e cada cliente respondido — até aquele que você nem viu chegar.', 'Sou a Maya. Sabe aquela mensagem que você jurou responder e esqueceu? Eu não esqueço. Comigo, todo cliente se sente o único. 💙', 'reduzir silencio e nao deixar ninguem no vacuo'],
  ['helena', 'Helena', 'Financeiro', 'financeiro', 'FINANCEIRO', 'Transforma o caos das planilhas em clareza: quem pagou, quem atrasou, quanto entra. Você decide olhando pro número, não no susto do fim do mês.', 'Helena aqui. Dinheiro não some — ele se esconde em atraso e planilha bagunçada. Comigo, você dorme sabendo exatamente como tá seu caixa.', 'decidir cobranca e caixa com clareza'],
  ['lara', 'Lara', 'Operacao', 'operacao', 'OPERACAO', 'Aquela tarefa travada há dias? Eu acho o gargalo, destravo o fluxo e o dia volta a andar — sem você caçar o problema.', 'Coisa emperrada me incomoda. Eu fuço, encontro e arrumo — e só te chamo quando tiver decisão de dono pra tomar.', 'destravar a operacao do dia a dia'],
  ['nina', 'Nina', 'Rotina', 'rotina', 'ROTINA', 'Organiza sua agenda e te diz por onde começar — o dia deixa de ser avalanche e vira uma lista que você consegue vencer.', 'Nina aqui! Acordou já se sentindo atrasado? Respira. Antes do café eu já te falo o que importa hoje — o resto a gente encaixa. 🌅', 'organizar o dia por prioridade'],
  // internas (implementação/cliente) — não aparecem na vitrine pública até terem foto/áudio próprios
  ['alice', 'Alice', 'Onboarding', 'cx', 'ONBOARDING', 'Sua Empresa.ia montada sob medida desde o dia um: entende seu negócio a fundo e configura tudo do jeito que a sua empresa funciona.', 'Sou a Alice. Adoro o comecinho: é quando eu aprendo cada detalhe do seu negócio pra entregar uma equipe que parece que sempre foi sua.', 'configurar a operacao certa desde o primeiro dia'],
  ['dani', 'Dani', 'Desenvolvimento', 'automacoes', 'DESENVOLVIMENTO', 'Suas ferramentas finalmente conversando: eu integro, automatizo e construo o que falta — o repetitivo some, sem você montar equipe de TI.', 'Se você faz a mesma coisa duas vezes, eu automatizo. Me dá o problema técnico que eu volto com ele funcionando.', 'construir e integrar a parte tecnica'],
  ['vivi', 'Vivi', 'Edição de Vídeo', 'conteudo', 'EDIÇÃO DE VÍDEO', 'Transforma vídeo bruto em cortes prontos: acha o gancho, edita vertical e entrega com legenda embutida.', 'Sou a Vivi, da edição. Me manda teu vídeo no grupo que eu devolvo os cortes prontos pra postar.', 'transformar vídeo bruto em clips que prendem'],
  // pessoal do dono: enxerga o WhatsApp PESSOAL do Fellipe (instancia propria) — so atende o dono
  ['duda', 'Duda', 'WhatsApp Pessoal', 'atendimento', 'SEU WHATSAPP', 'Cuida do seu WhatsApp pessoal: lê tudo, resume o que importa e te mostra quem não pode esperar — sem você se afogar em 200 mensagens.', 'Sou a Duda, e cuido só de você. O mundo te manda mensagem sem parar; eu te entrego só o essencial — e quem é especial nunca fica esperando.', 'gerenciar o WhatsApp pessoal do Fellipe'],
].map(([id, name, role, category, badge, solution, insight, mission], index) => ({
  id,
  index: index + 1,
  name,
  role,
  category,
  badge,
  solution,
  insight,
  mission,
  sector: role,
  internal: id === 'alice' || id === 'dani' || id === 'duda' || id === 'vivi',
  image: `employee-${id}.jpg`,
  audio: `audio-${id}.ogg`,
  fallbackImage: employeeFallbackAssets[category] || carouselAssets.empresa,
  callAction: `call_employee_${id}`,
  primaryAction: `talk_${id}`,
}));

const employeesById = new Map(employees.map(employee => [employee.id, employee]));

function assetUrl(name) {
  return `${ASSET_BASE}${name}`;
}

function resolveCarouselImage(card) {
  const image = card.image || carouselAssets.empresa;
  if (card.fallbackImage && !fs.existsSync(`${PUBLIC_DIR}/${image}`)) return card.fallbackImage;
  return image;
}

function buttonLabel(id, fallback = '') {
  const key = String(id || '');
  if (key.startsWith('call_employee_')) {
    const employee = employeesById.get(key.replace(/^call_employee_/, ''));
    return `📞 ${employee?.name || 'Ligar'}`;
  }
  if (/^employee_page_/.test(key)) return key.endsWith('_1') ? '↩️ Início' : '➡️ Mais';
  const labels = {
    '@empresa': '🏠 Início',
    '@apps': '📱 Apps',
    '@setores': '🧩 Setores',
    '@funcionarios': '👥 Equipe',
    '@equipe': '👥 Equipe',
    '@radar': '🔎 Radar',
    '@ceo': '🧠 CEO',
    '@warroom': '🚨 Plano',
    '@rotinas': '🔁 Rotina',
    apps_crm_priorizar: '💰 Leads',
    apps_crm_msg: '✍️ Mensagem',
    apps_crm_risco: '⚠️ Risco',
    apps_ig_conversa: '💬 Responder',
    apps_ig_topicos: '💡 Pautas',
    apps_ig_post: '📝 Post',
    apps_meta_vencedor: '🎯 Vencedor',
    apps_meta_cortar: '✂️ Cortar',
    apps_meta_ajustar: '🔁 Verba',
    apps_wa_prioridades: '🔥 Fila',
    apps_wa_followup: '✍️ Follow-up',
    apps_wa_resumo: '📋 Resumo',
    apps_auto_desempenho: '📈 Auditar',
    apps_auto_falhas: '🛠️ Falhas',
    apps_auto_criar: '⚙️ Fluxo',
    apps_financeiro_entradas: '💵 Caixa',
    apps_financeiro_atrasos: '⏰ Atrasos',
    apps_financeiro_caixa: '📊 Projetar',
    apps_ia_recomendacao: '🧠 Ideia',
    apps_ia_gargalo: '🚧 Gargalo',
    apps_ia_crescer: '🚀 Crescer',
    mission_leads: '🚀 Resgate',
    mission_ads: '🚀 Ads',
    mission_conteudo: '🚀 Conteúdo',
    mission_atendimento: '🚀 Fila',
    mission_rotina: '🚀 Rotina',
    routine_daily: '☀️ Diário',
    routine_sales: '💰 Comercial',
    routine_ads: '🎯 Ads',
    routine_content: '📝 Conteúdo',
    routine_auto: '⚙️ Alerta',
    routine_adjust: '🔧 Ajustar',
    connect_crm: '🔌 CRM',
    connect_instagram: '🔌 Insta',
    connect_ads: '🔌 Ads',
    connect_whatsapp: '🔌 WhatsApp',
    connect_automation: '🔌 Fluxos',
    connect_finance: '🔌 Caixa',
    draft_followups: '✍️ Rascunho',
    draft_content: '📝 Pauta',
    confirm_sensitive: '✅ Aprovar',
    automation_brief: '⚙️ Brief',
    site_revisar: '🔍 Página',
    site_publicar: '🚀 Publicar',
  };
  if (labels[key]) return labels[key];
  const text = String(fallback || key || 'Abrir').trim();
  return text.length > 18 ? text.slice(0, 17).trim() : text;
}

function replyButton(id, text) {
  return { id, text: buttonLabel(id, text), type: 'REPLY' };
}

function flowButton(id, label) {
  return [id, label];
}

function specialistById(id) {
  return employeesById.get(id) || employeesById.get('atlas');
}

function conversationalCue(cards) {
  const categories = new Set((cards || []).flatMap(card => card.categories || [card.category]).filter(Boolean));
  if (categories.has('receita')) return 'Pode falar comigo normal: "clientes parados", "propostas sem resposta" ou "me liga sobre vendas".';
  if (categories.has('crescimento')) return 'Pode falar comigo normal: "ver campanhas", "cortar verba ruim" ou "qual criativo venceu?".';
  if (categories.has('atendimento')) return 'Pode falar comigo normal: "resumir fila", "quem ficou sem resposta?" ou "me ajuda no WhatsApp".';
  if (categories.has('financeiro')) return 'Pode falar comigo normal: "como esta o caixa?", "quem esta atrasado?" ou "me liga sobre financeiro".';
  if (categories.has('conteudo')) return 'Pode falar comigo normal: "criar post", "ler comentarios" ou "o que virou pauta?".';
  if (categories.has('automacoes')) return 'Pode falar comigo normal: "que fluxo quebrou?", "automatiza isso" ou "cria um alerta".';
  return 'Pode falar comigo normal. Os botoes sao atalhos, nao o unico caminho.';
}

function carousel(text, cards, chatid = null) {
  const orderedCards = chatid ? personalizeCards(cards, chatid) : cards;
  const context = chatid ? usageContextText(chatid) : '';
  const cue = conversationalCue(orderedCards);
  const intro = [text, context, cue].filter(Boolean).join('\n');
  return {
    text: intro,
    carousel: orderedCards.map(card => ({
      text: card.text,
      image: assetUrl(resolveCarouselImage(card)),
      buttons: card.buttons.slice(0, 3).map(([id, label]) => replyButton(id, label)),
    })),
    readchat: true,
    delay: 0,
  };
}

function naturalEmpresaiaIntent(key) {
  const text = String(key || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!text || text.startsWith('@')) return null;
  if (/\b(campanha|anuncio|trafego|ads|verba|criativo venceu|criativo)\b/.test(text)) return 'apps_meta_vencedor';
  if (/\b(cliente|lead|proposta|venda|comercial|follow|negocio|crm)\b/.test(text)) return 'apps_crm_priorizar';
  if (/\b(caixa|financeiro|cobranca|cobrar|atrasado|boleto|recebivel)\b/.test(text)) return 'apps_financeiro_entradas';
  if (/\b(whatsapp|atendimento|fila|responder|suporte|cliente irritado)\b/.test(text)) return 'apps_wa_prioridades';
  if (/\b(post|conteudo|instagram|comentario|dm|pauta|story)\b/.test(text)) return 'apps_ig_topicos';
  if (/\b(automacao|fluxo|rotina|processo|operacao|alerta|quebrou)\b/.test(text)) return 'apps_auto_falhas';
  if (/\b(site|pagina|checkout|conversao|landing)\b/.test(text)) return 'site_revisar';
  if (/\b(estrategia|ceo|direcao|prioridade|decisao|gargalo)\b/.test(text)) return '@ceo';
  if (/\b(equipe|funcionario|pessoa|especialista|me liga|ligar|chamada)\b/.test(text)) return '@funcionarios';
  return null;
}

function vitrineCarousel(chatid = null) {
  const cards = employees.filter(e => !e.internal).map(employeeCard);
  return carousel('Essa é a equipe da sua Empresa.ia. Toque em "Falar com" quem você precisar — ou me conta o que tá pegando que eu te levo até a pessoa certa.', cards, chatid);
}

function empresaHomeCarousel(chatid) {
  return vitrineCarousel(chatid);
}

function relatorioCarousel(chatid = null) {
  const cards = employees.filter(e => e.id !== 'sofia' && !e.internal).map(employee => ({
    category: employee.category,
    image: employee.image,
    fallbackImage: employee.fallbackImage,
    text: `*${employee.role}*\n━━━━━━━━━━━━\n${employee.insight}`,
    buttons: [[employee.primaryAction, `Ver com a ${employee.name}`], [employee.callAction, `${employee.name} liga`]],
  }));
  return carousel('Seu resumo do dia, por setor. Toque pra entrar onde precisa de você.', cards, chatid);
}

function setoresCarousel(chatid) {
  return carousel('Setores da Empresa.ia. Escolha o tipo de pressao que quer resolver.', [
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*Receita*\n━━━━━━━━━━━━\nClientes, leads, propostas, contratos e follow-ups.\nFoco: transformar historico em proximo movimento comercial.',
      buttons: [['apps_crm_priorizar', 'Dinheiro parado'], ['call_employee_clara', 'Clara liga'], ['mission_leads', 'Resgate']],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Crescimento*\n━━━━━━━━━━━━\nMeta Ads, Google Ads, funil, criativos e verba.\nFoco: achar vencedor, cortar perda e acelerar campanha.',
      buttons: [['apps_meta_vencedor', 'Provar sinal'], ['call_employee_iris', 'Iris liga'], ['mission_ads', 'War ads']],
    },
    {
      category: 'conteudo',
      image: carouselAssets.instagram,
      text: '*Conteudo e Reputacao*\n━━━━━━━━━━━━\nInstagram, comentarios, ideias, pauta e continuidade.\nFoco: transformar audiencia em conversa e conversa em demanda.',
      buttons: [['apps_ig_topicos', 'Ler demanda'], ['call_employee_bia', 'Bia liga'], ['mission_conteudo', 'Linha editorial']],
    },
    {
      category: 'atendimento',
      image: carouselAssets.whatsapp,
      text: '*Atendimento*\n━━━━━━━━━━━━\nWhatsApp, grupos, fila, contexto e retomadas.\nFoco: reduzir silencio e aumentar velocidade de resposta.',
      buttons: [['apps_wa_prioridades', 'Fila critica'], ['call_employee_maya', 'Maya liga'], ['mission_atendimento', 'Arrumar fila']],
    },
    {
      category: 'sites',
      image: carouselAssets.conteudo,
      text: '*Sites e Conversao*\n━━━━━━━━━━━━\nLanding pages, checkout, tracking, copy e publicacao.\nFoco: tirar atrito do caminho ate a compra.',
      buttons: [['site_revisar', 'Achar atrito'], ['call_employee_caio', 'Caio liga'], ['site_publicar', 'Publicar seguro']],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Automacoes*\n━━━━━━━━━━━━\nRotinas, alertas, tarefas repetidas e aprovacoes.\nFoco: operacao invisivel com confirmacao antes de agir.',
      buttons: [['apps_auto_falhas', 'Cacar falha'], ['call_employee_max', 'Max liga'], ['apps_auto_criar', 'Novo fluxo']],
    },
    {
      category: 'financeiro',
      image: carouselAssets.google,
      text: '*Financeiro e Dados*\n━━━━━━━━━━━━\nEntradas, atrasos, planilhas, BI e previsao.\nFoco: decidir com caixa, risco e tendencia na mesma tela.',
      buttons: [['apps_financeiro_entradas', 'Caixa hoje'], ['call_employee_otto', 'Otto liga'], ['apps_financeiro_atrasos', 'Cobrar certo']],
    },
  ], chatid);
}

function appsCarousel(isOwner = false, chatid = null) {
  const prefix = isOwner ? '@apps - escolha uma frente.' : 'Empresa.ia - escolha uma frente.';
  return carousel(prefix, [
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*CRM Vivo*\nLeads quentes, propostas paradas e clientes sem proximo passo.\n\nAgora: separar quem pode virar caixa hoje.',
      buttons: [flowButton('apps_crm_priorizar', 'Mapa quente'), flowButton('call_employee_clara', 'Clara liga'), flowButton('mission_leads', 'Missao resgate')],
    },
    {
      category: 'conteudo',
      image: carouselAssets.instagram,
      text: '*Social Listening*\nComentarios, DMs e posts revelam dor real.\n\nAgora: transformar sinal em resposta, pauta e campanha.',
      buttons: [flowButton('apps_ig_topicos', 'Ler audiencia'), flowButton('call_employee_bia', 'Bia cria'), flowButton('routine_content', 'Pulso semanal')],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Mesa de Performance*\nCampanha, criativo e verba viram decisao.\n\nAgora: achar vencedor, cortar perda e realocar.',
      buttons: [flowButton('apps_meta_vencedor', 'Achar vencedor'), flowButton('call_employee_iris', 'Iris liga'), flowButton('@ceo', 'Mesa CEO')],
    },
    {
      category: 'atendimento',
      image: carouselAssets.whatsapp,
      text: '*WhatsApp em Risco*\nConversa parada esfria receita.\n\nAgora: priorizar fila e retomar com contexto.',
      buttons: [flowButton('apps_wa_prioridades', 'Fila critica'), flowButton('call_employee_ayla', 'Ayla liga'), flowButton('apps_wa_followup', 'Rascunhar')],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Operacao Invisivel*\nFluxo quebrado vira atraso silencioso.\n\nAgora: achar falha e transformar repeticao em sistema.',
      buttons: [flowButton('apps_auto_falhas', 'Cacar falha'), flowButton('call_employee_max', 'Max liga'), flowButton('apps_auto_criar', 'Desenhar fluxo')],
    },
    {
      category: 'financeiro',
      image: carouselAssets.google,
      text: '*Caixa em Tempo Real*\nEntrada, atraso e compromisso no mesmo radar.\n\nAgora: decidir se cobra, segura ou acelera.',
      buttons: [flowButton('apps_financeiro_entradas', 'Caixa hoje'), flowButton('call_employee_otto', 'Otto liga'), flowButton('apps_financeiro_atrasos', 'Cobrar certo')],
    },
    {
      categories: ['ceo', 'radar'],
      image: carouselAssets.conteudo,
      text: '*Diretoria Invisivel*\nVendas, midia, atendimento e caixa em uma leitura.\n\nAgora: transformar ruido em decisao executiva.',
      buttons: [flowButton('apps_ia_gargalo', 'Gargalo real'), flowButton('call_employee_atlas', 'Atlas liga'), flowButton('@warroom', 'War room')],
    },
  ], chatid);
}

function employeeButtons(employee) {
  return [
    [employee.primaryAction, `Falar com a ${employee.name}`],
    [employee.callAction, `${employee.name} liga`],
  ];
}

function employeeCard(employee) {
  return {
    category: employee.category,
    image: employee.image,
    fallbackImage: employee.fallbackImage,
    text: `*${employee.name} — ${employee.role}*\n━━━━━━━━━━━━\n${employee.solution}`,
    buttons: employeeButtons(employee),
  };
}

function employeeUsageScore(chatid, employee) {
  const profile = empresaiaUsageProfile(chatid);
  return (profile.commands?.[employee.callAction] || 0)
    + (profile.commands?.[`employee_${employee.id}`] || 0)
    + (profile.categories?.[employee.category] || 0) * 0.5;
}

function orderedEmployeesForChat(chatid) {
  return employees
    .filter(e => !e.internal)
    .map((employee, originalIndex) => ({ employee, originalIndex, score: employeeUsageScore(chatid, employee) }))
    .sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex))
    .map(item => item.employee);
}

function employeesCarousel(chatid = null) {
  return vitrineCarousel(chatid);
}

function employeeDetailCarousel(id, chatid = null) {
  const employee = employeesById.get(id);
  if (!employee) return null;
  return carousel(`${employee.name} pronta pra te ajudar.`, [
    {
      category: employee.category,
      image: employee.image,
      fallbackImage: employee.fallbackImage,
      text: `*${employee.name} — ${employee.role}*\n━━━━━━━━━━━━\n${employee.solution}\n\n${employee.insight}`,
      buttons: [[employee.callAction, `${employee.name} liga`], ['@equipe', 'Ver a equipe']],
    },
  ], chatid);
}

function radarCarousel(chatid) {
  return carousel('Radar de hoje. Escolha qual sinal merece atencao agora.', [
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*Dinheiro Parado*\n━━━━━━━━━━━━\nOportunidades sem proximo passo merecem prioridade antes de campanha nova.\n👉 Comece recuperando quem ja demonstrou intencao.',
      buttons: [['apps_crm_priorizar', 'Rankear agora'], ['call_employee_clara', 'Clara liga'], ['mission_leads', 'Resgate']],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Verba em Risco*\n━━━━━━━━━━━━\nQuando a performance muda, a decisao precisa vir antes do relatorio.\n👉 Compare campeao e vazamento.',
      buttons: [['apps_meta_vencedor', 'Provar vencedor'], ['call_employee_iris', 'Iris liga'], ['apps_meta_cortar', 'Cortar perda']],
    },
    {
      category: 'atendimento',
      image: carouselAssets.whatsapp,
      text: '*Silencio Caro*\n━━━━━━━━━━━━\nConversas quase prontas podem esfriar por falta de retorno.\n👉 Eu montaria a fila de retomada.',
      buttons: [['apps_wa_prioridades', 'Fila critica'], ['call_employee_ayla', 'Ayla liga'], ['apps_wa_followup', 'Retomar']],
    },
    {
      category: 'conteudo',
      image: carouselAssets.instagram,
      text: '*Audiencia Chamando*\n━━━━━━━━━━━━\nComentarios, DMs e engajamento viram pauta, resposta e venda.\n👉 Use o que a audiencia ja pediu.',
      buttons: [['apps_ig_topicos', 'Extrair demanda'], ['call_employee_bia', 'Bia liga'], ['apps_ig_post', 'Virar post']],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Gargalo Invisivel*\n━━━━━━━━━━━━\nFluxo parado parece pequeno ate travar venda, suporte ou entrega.\n👉 Audite o que roda todo dia.',
      buttons: [['apps_auto_falhas', 'Cacar falha'], ['call_employee_gael', 'Gael liga'], ['routine_auto', 'Monitorar']],
    },
  ], chatid);
}

function ceoCarousel(chatid) {
  return carousel('Modo CEO. Aqui so entra decisao, risco, dinheiro e alavanca.', [
    {
      category: 'ceo',
      image: carouselAssets.empresa,
      text: '*Decidir Agora*\n━━━━━━━━━━━━\nA Empresa.ia filtra ruido e coloca decisao na sua frente.\n👉 Escolha onde quer concentrar energia nas proximas horas.',
      buttons: [['@radar', 'Achar pressao'], ['call_employee_atlas', 'Atlas liga'], ['@warroom', 'Plano 24h']],
    },
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*Receita Antes de Vaidade*\n━━━━━━━━━━━━\nSe ja existe lead, comprar mais atencao pode ser a segunda jogada.\n👉 Priorize fechamento e retomada.',
      buttons: [['apps_crm_priorizar', 'Rankear deals'], ['call_employee_vera', 'Vera liga'], ['mission_leads', 'Cadencia']],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Capital em Movimento*\n━━━━━━━━━━━━\nA verba precisa provar que merece continuar onde esta.\n👉 Corte perda, aumente sinal, revise criativo.',
      buttons: [['apps_meta_cortar', 'Cortar perda'], ['call_employee_iris', 'Iris liga'], ['confirm_sensitive', 'Aprovar ajuste']],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Tempo Devolvido*\n━━━━━━━━━━━━\nO melhor processo e o que some da agenda sem perder controle.\n👉 Transforme repeticao em rotina com aprovacao humana.',
      buttons: [['apps_auto_criar', 'Desenhar fluxo'], ['call_employee_max', 'Max liga'], ['routine_auto', 'Monitorar']],
    },
  ], chatid);
}

function warroomCarousel(chatid) {
  return carousel('War Room. Escolha uma missao e eu junto setor, app, pessoa e proxima acao.', [
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*Recuperar Leads Parados*\n━━━━━━━━━━━━\nMissao: achar oportunidades esquecidas, escrever retomadas e criar cadencia.\n👉 Melhor para gerar venda sem comprar trafego novo.',
      buttons: [['mission_leads', 'Abrir missao'], ['call_employee_clara', 'Clara liga'], ['apps_wa_followup', 'Rascunhar']],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Revisar Campanhas*\n━━━━━━━━━━━━\nMissao: comparar campanhas, achar vencedor e cortar desperdicio.\n👉 Melhor quando performance ficou nebulosa.',
      buttons: [['mission_ads', 'Abrir missao'], ['call_employee_iris', 'Iris liga'], ['apps_meta_cortar', 'Cortar perda']],
    },
    {
      category: 'conteudo',
      image: carouselAssets.conteudo,
      text: '*Lancar Conteudo da Semana*\n━━━━━━━━━━━━\nMissao: transformar sinais de audiencia em pauta, criativo e publicacao.\n👉 Melhor para manter presenca com direcao.',
      buttons: [['mission_conteudo', 'Abrir missao'], ['call_employee_bia', 'Bia liga'], ['apps_ig_post', 'Criar post']],
    },
    {
      category: 'atendimento',
      image: carouselAssets.whatsapp,
      text: '*Arrumar Atendimento*\n━━━━━━━━━━━━\nMissao: mapear fila, resumir contexto e preparar respostas.\n👉 Melhor quando o WhatsApp virou gargalo.',
      buttons: [['mission_atendimento', 'Abrir missao'], ['call_employee_maya', 'Maya liga'], ['apps_wa_resumo', 'Resumo']],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Criar Rotina Automatica*\n━━━━━━━━━━━━\nMissao: escolher gatilho, acao e aprovacao.\n👉 Melhor quando a operacao repete o mesmo trabalho.',
      buttons: [['mission_rotina', 'Abrir missao'], ['call_employee_max', 'Max liga'], ['apps_auto_criar', 'Desenhar']],
    },
  ], chatid);
}

function rotinasCarousel(chatid) {
  return carousel('Rotinas da Empresa.ia. Escolha o que deve voltar sozinho antes de virar problema.', [
    {
      categories: ['ceo', 'radar'],
      image: carouselAssets.empresa,
      text: '*Briefing Diario*\n━━━━━━━━━━━━\nTodo dia: prioridades, riscos, dinheiro parado e proxima decisao.\n👉 Bom para comecar o dia sem abrir 8 ferramentas.',
      buttons: [['routine_daily', 'Desenhar ritual'], ['call_employee_cora', 'Cora liga'], ['@radar', 'Ver pressao']],
    },
    {
      category: 'receita',
      image: carouselAssets.crm,
      text: '*Radar Comercial*\n━━━━━━━━━━━━\nAcompanha leads, propostas, follow-ups e clientes sem movimento.\n👉 Bom para recuperar receita antes de esfriar.',
      buttons: [['routine_sales', 'Criar pulso'], ['call_employee_clara', 'Clara liga'], ['apps_crm_priorizar', 'Ver agora']],
    },
    {
      category: 'crescimento',
      image: carouselAssets.meta,
      text: '*Revisao de Campanha*\n━━━━━━━━━━━━\nCheca verba, queda, campeao e criativo que precisa trocar.\n👉 Bom para nao deixar midia rodar no escuro.',
      buttons: [['routine_ads', 'Criar pulso'], ['call_employee_iris', 'Iris liga'], ['apps_meta_vencedor', 'Ver sinal']],
    },
    {
      category: 'conteudo',
      image: carouselAssets.instagram,
      text: '*Pulso de Conteudo*\n━━━━━━━━━━━━\nTransforma comentarios, ideias e pautas em proximo post.\n👉 Bom para criar a partir do que a audiencia ja pediu.',
      buttons: [['routine_content', 'Criar pulso'], ['call_employee_bia', 'Bia liga'], ['apps_ig_topicos', 'Ver pautas']],
    },
    {
      category: 'automacoes',
      image: carouselAssets.automacoes,
      text: '*Alerta de Automacao*\n━━━━━━━━━━━━\nAvisa quando fluxo quebra, atrasa ou perde evento importante.\n👉 Bom para manter a operacao invisivel sob controle.',
      buttons: [['routine_auto', 'Criar alerta'], ['call_employee_gael', 'Gael liga'], ['apps_auto_falhas', 'Ver falha']],
    },
  ], chatid);
}

const specialistByCategory = {
  cx: 'sofia',
  conteudo: 'bia',
  crm: 'clara',
  atendimento: 'maya',
  financeiro: 'helena',
  operacao: 'lara',
  rotina: 'nina',
};

function specialistForAction(id, fallbackCategory = null) {
  const exact = employees.find(employee => employee.primaryAction === id);
  if (exact) return exact;
  const category = fallbackCategory || null;
  return employeesById.get(specialistByCategory[category]) || employeesById.get('sofia');
}

function specialistCard(employee, contextLabel = 'acao') {
  return {
    category: employee.category,
    image: employee.image,
    fallbackImage: employee.fallbackImage,
    text: `*${employee.name} — ${employee.role}*\n━━━━━━━━━━━━\n${employee.solution}\n\n${employee.insight}`,
    buttons: [[employee.callAction, `${employee.name} liga`], [employee.primaryAction, `Falar com a ${employee.name}`]],
  };
}

const actionPlaybooks = {
  apps_crm_priorizar: [['connect_crm', 'Puxar CRM'], ['call_employee_clara', 'Clara liga'], ['mission_leads', 'Resgate 5x']],
  apps_crm_msg: [['draft_followups', 'Criar 3 tons'], ['call_employee_vera', 'Vera liga'], ['apps_wa_followup', 'Enviar com contexto']],
  apps_crm_risco: [['connect_crm', 'Achar buracos'], ['call_employee_bruno', 'Bruno liga'], ['@warroom', 'Sala de risco']],
  apps_ig_conversa: [['connect_instagram', 'Ler comentarios'], ['call_employee_mila', 'Mila liga'], ['apps_ig_post', 'Virar post']],
  apps_ig_topicos: [['apps_ig_post', 'Criar linha'], ['call_employee_bia', 'Bia liga'], ['routine_content', 'Pulso semanal']],
  apps_ig_post: [['draft_content', 'Montar pauta'], ['call_employee_theo', 'Theo liga'], ['confirm_sensitive', 'Aprovar antes']],
  apps_meta_vencedor: [['connect_ads', 'Ler campanhas'], ['call_employee_iris', 'Iris liga'], ['apps_meta_ajustar', 'Realocar']],
  apps_meta_cortar: [['connect_ads', 'Achar perda'], ['call_employee_teo', 'Teo liga'], ['confirm_sensitive', 'Corte seguro']],
  apps_meta_ajustar: [['apps_meta_vencedor', 'Ver prova'], ['call_employee_renan', 'Renan liga'], ['confirm_sensitive', 'Aprovar ajuste']],
  apps_wa_prioridades: [['connect_whatsapp', 'Ler fila'], ['call_employee_ayla', 'Ayla liga'], ['apps_wa_followup', 'Retomar']],
  apps_wa_followup: [['draft_followups', '3 respostas'], ['call_employee_sofia', 'Sofia liga'], ['confirm_sensitive', 'Aprovar envio']],
  apps_wa_resumo: [['apps_wa_prioridades', 'Ordenar risco'], ['call_employee_maya', 'Maya liga'], ['routine_sales', 'Criar pulso']],
  apps_auto_desempenho: [['apps_auto_falhas', 'Ver quebra'], ['call_employee_gael', 'Gael liga'], ['routine_auto', 'Monitorar']],
  apps_auto_falhas: [['connect_automation', 'Ler fluxos'], ['call_employee_max', 'Max liga'], ['apps_auto_criar', 'Corrigir fluxo']],
  apps_auto_criar: [['automation_brief', 'Desenhar regra'], ['call_employee_max', 'Max liga'], ['confirm_sensitive', 'Publicar seguro']],
  apps_financeiro_entradas: [['connect_finance', 'Puxar fonte'], ['call_employee_otto', 'Otto liga'], ['apps_financeiro_caixa', 'Projetar']],
  apps_financeiro_atrasos: [['connect_finance', 'Listar atrasos'], ['call_employee_eric', 'Eric liga'], ['confirm_sensitive', 'Cobrar com tom']],
  apps_financeiro_caixa: [['apps_financeiro_entradas', 'Ver entradas'], ['call_employee_otto', 'Otto liga'], ['@ceo', 'Decidir hoje']],
  apps_ia_recomendacao: [['apps_ia_gargalo', 'Achar trava'], ['call_employee_atlas', 'Atlas liga'], ['@warroom', 'Plano 24h']],
  apps_ia_gargalo: [['@radar', 'Cruzar sinais'], ['call_employee_noah', 'Noah liga'], ['mission_leads', 'Atacar gargalo']],
  apps_ia_crescer: [['@warroom', 'Montar ataque'], ['call_employee_orion', 'Orion liga'], ['@rotinas', 'Virar ritual']],
};

function actionCarousel(id, chatid = null) {
  const definitions = {
    apps_crm_priorizar: ['Proxima Melhor Receita', carouselAssets.crm, 'Eu vou cruzar valor, tempo parado e chance de fechamento.\nSe o CRM estiver conectado, trago a lista real; se nao estiver, peço a fonte certa.\n👉 Comece por quem pode virar caixa hoje.', [['connect_crm', 'Conectar CRM'], ['apps_crm_msg', 'Criar abordagens'], ['@radar', 'Voltar radar']]],
    apps_crm_msg: ['Abordagens Prontas', carouselAssets.crm, 'Eu preparo mensagens curtas de retomada por tipo de lead.\nNada sai sem aprovacao.\n👉 O objetivo e reabrir conversa sem parecer disparo.', [['draft_followups', 'Gerar rascunhos'], ['apps_crm_priorizar', 'Escolher leads'], ['@apps', 'Apps']]],
    apps_crm_risco: ['Risco Comercial', carouselAssets.crm, 'Eu procuro propostas antigas, leads sem retorno e clientes sem proximo passo.\n👉 O resultado vira uma lista de risco com acao recomendada.', [['connect_crm', 'Conectar fonte'], ['apps_wa_followup', 'Retomar'], ['@setores', 'Setores']]],
    apps_ig_conversa: ['Resposta com Contexto', carouselAssets.instagram, 'Eu vejo comentarios e conversas antes de sugerir resposta.\nQuando a fonte estiver conectada, trago rascunhos e peço confirmacao.\n👉 Presenca no timing certo.', [['connect_instagram', 'Conectar Insta'], ['apps_ig_topicos', 'Extrair pautas'], ['@apps', 'Apps']]],
    apps_ig_topicos: ['Pautas da Audiencia', carouselAssets.instagram, 'Eu transformo perguntas, comentarios e temas recorrentes em pauta.\n👉 Conteudo nasce do que o publico ja sinalizou.', [['apps_ig_post', 'Criar post'], ['connect_instagram', 'Conectar Insta'], ['@warroom', 'War Room']]],
    apps_ig_post: ['Continuidade de Conteudo', carouselAssets.conteudo, 'Eu proponho gancho, tese, formato e CTA.\nPublicacao real sempre pede confirmacao.\n👉 O post continua uma conversa que ja comecou.', [['draft_content', 'Gerar pauta'], ['apps_ig_topicos', 'Ver temas'], ['@rotinas', 'Rotina']]],
    apps_meta_vencedor: ['Campanha Campea', carouselAssets.meta, 'Eu comparo campanha, criativo e sinal de conversao.\nSe a fonte estiver conectada, trago o vencedor real.\n👉 A decisao e aumentar o que prova retorno.', [['connect_ads', 'Conectar Ads'], ['apps_meta_ajustar', 'Realocar'], ['@apps', 'Apps']]],
    apps_meta_cortar: ['Vazamento de Verba', carouselAssets.meta, 'Eu procuro campanha cara, criativo cansado e audiencia sem resposta.\nCorte ou pausa exigem confirmacao.\n👉 Primeiro diagnostico, depois acao.', [['connect_ads', 'Conectar Ads'], ['apps_meta_vencedor', 'Comparar'], ['@ceo', 'Modo CEO']]],
    apps_meta_ajustar: ['Realocacao Assistida', carouselAssets.meta, 'Eu monto proposta de ajuste com motivo, risco e impacto esperado.\nNada altera campanha sem aprovar.\n👉 Humano decide; sistema prepara.', [['confirm_sensitive', 'Ver confirmacao'], ['apps_meta_vencedor', 'Ver campeao'], ['@radar', 'Radar']]],
    apps_wa_prioridades: ['Fila Quente', carouselAssets.whatsapp, 'Eu separo conversas por urgencia, intencao e tempo sem resposta.\n👉 Atendimento vira fila de oportunidade.', [['connect_whatsapp', 'Usar WhatsApp'], ['apps_wa_followup', 'Escrever'], ['apps_wa_resumo', 'Resumo']]],
    apps_wa_followup: ['Follow-ups Inteligentes', carouselAssets.whatsapp, 'Eu escrevo retomadas com base no contexto e no proximo passo.\nEnvio real precisa confirmacao.\n👉 Recuperar timing sem soar automatico.', [['draft_followups', 'Gerar rascunhos'], ['confirm_sensitive', 'Confirmacao'], ['@rotinas', 'Criar rotina']]],
    apps_wa_resumo: ['Resumo da Fila', carouselAssets.whatsapp, 'Eu resumo conversas, pendencias e quem precisa de resposta.\n👉 Menos rolagem, mais decisao.', [['apps_wa_prioridades', 'Priorizar'], ['apps_wa_followup', 'Retomar'], ['@setores', 'Setores']]],
    apps_auto_desempenho: ['Auditoria de Fluxo', carouselAssets.automacoes, 'Eu olho rotinas, gatilhos e pontos de falha.\n👉 Automacao boa fica invisivel; automacao ruim vira alerta.', [['apps_auto_falhas', 'Ver falhas'], ['apps_auto_criar', 'Criar fluxo'], ['@rotinas', 'Rotinas']]],
    apps_auto_falhas: ['Falhas Invisiveis', carouselAssets.automacoes, 'Eu procuro eventos sem conclusao, integracoes mudas e rotinas atrasadas.\n👉 O que falha no fundo vira prioridade na frente.', [['connect_automation', 'Conectar fluxos'], ['apps_auto_desempenho', 'Auditar'], ['@radar', 'Radar']]],
    apps_auto_criar: ['Nova Automacao', carouselAssets.automacoes, 'Eu desenho gatilho, regra, acao e confirmacao.\n👉 Uma pergunta por vez ate virar fluxo implementavel.', [['automation_brief', 'Comecar brief'], ['@rotinas', 'Ver rotinas'], ['@warroom', 'War Room']]],
    apps_financeiro_entradas: ['Entradas de Hoje', carouselAssets.google, 'Eu cruzo recebimentos, atrasos e previsao curta.\nSe nao houver fonte conectada, eu te guio para planilha, ERP ou checkout.\n👉 Caixa antes de compromisso.', [['connect_finance', 'Conectar fonte'], ['apps_financeiro_atrasos', 'Atrasos'], ['apps_financeiro_caixa', 'Projetar']]],
    apps_financeiro_atrasos: ['Atrasos e Cobranca', carouselAssets.google, 'Eu priorizo atraso por valor, tempo e chance de recuperacao.\nCobranca enviada precisa aprovacao.\n👉 Proteger caixa sem ruído.', [['connect_finance', 'Conectar fonte'], ['confirm_sensitive', 'Confirmacao'], ['@ceo', 'CEO']]],
    apps_financeiro_caixa: ['Projecao de Caixa', carouselAssets.google, 'Eu monto visao curta: entradas previstas, riscos e folga.\n👉 Decisao fica mais simples quando caixa entra no radar.', [['connect_finance', 'Conectar fonte'], ['apps_financeiro_entradas', 'Entradas'], ['@radar', 'Radar']]],
    apps_ia_recomendacao: ['Recomendacao Estrategica', carouselAssets.conteudo, 'Eu cruzo sinais de funil, midia, conversa e operacao.\n👉 Nao e painel; e a proxima jogada mais provavel.', [['apps_ia_crescer', '3 jogadas'], ['apps_ia_gargalo', 'Gargalo'], ['@ceo', 'CEO']]],
    apps_ia_gargalo: ['Gargalo Provavel', carouselAssets.conteudo, 'Eu busco onde a energia trava: captacao, atendimento, proposta, entrega ou follow-up.\n👉 Corrigir gargalo costuma render mais que adicionar ferramenta.', [['@radar', 'Investigar'], ['@warroom', 'Criar missao'], ['@setores', 'Setores']]],
    apps_ia_crescer: ['3 Jogadas da Semana', carouselAssets.conteudo, 'Eu devolvo tres movimentos: recuperar, acelerar e automatizar.\n👉 Crescimento vira sequencia de decisoes pequenas.', [['@warroom', 'War Room'], ['@rotinas', 'Rotinas'], ['@apps', 'Apps']]],
  };
  if (/^sector_/.test(id)) return sectorDetailCarousel(id, chatid);
  if (/^mission_/.test(id)) return missionDetailCarousel(id, chatid);
  if (/^routine_/.test(id)) return routineDetailCarousel(id, chatid);
  if (/^(connect_|draft_|confirm_|automation_|site_)/.test(id)) return setupCarousel(id, chatid);
  const def = definitions[id];
  if (!def) return null;
  const [title, image, body, buttons] = def;
  const specialist = specialistForAction(id);
  const playbookButtons = actionPlaybooks[id] || buttons;
  return carousel(`${title}.`, [
    {
      image,
      category: specialist.category,
      text: `*${title}*\n━━━━━━━━━━━━\n${body}\n\n*Estado*\nPreparado para diagnosticar, pedir fonte ou executar com confirmacao.`,
      buttons: playbookButtons,
    },
    specialistCard(specialist, title),
    {
      image: carouselAssets.empresa,
      categories: ['ceo', 'radar'],
      text: '*Proximo Movimento*\n━━━━━━━━━━━━\nA Empresa.ia continua em trilha: app, setor, especialista ou rotina.\n\n*Boa regra*\nSe mexe em cliente, dinheiro, campanha ou envio, pede confirmacao antes.',
      buttons: [['@empresa', 'Inicio'], ['@apps', 'Apps'], ['@radar', 'Radar']],
    },
  ], chatid);
}

function sectorDetailCarousel(id, chatid = null) {
  const map = {
    sector_receita: ['Receita', carouselAssets.crm, [['apps_crm_priorizar', 'Priorizar dinheiro'], ['apps_crm_msg', 'Criar abordagens'], ['apps_crm_risco', 'Ver risco']]],
    sector_crescimento: ['Crescimento', carouselAssets.meta, [['apps_meta_vencedor', 'Ver campeao'], ['apps_meta_cortar', 'Cortar vazamento'], ['apps_meta_ajustar', 'Realocar']]],
    sector_conteudo: ['Conteudo', carouselAssets.instagram, [['apps_ig_conversa', 'Responder'], ['apps_ig_topicos', 'Pautas'], ['apps_ig_post', 'Criar post']]],
    sector_atendimento: ['Atendimento', carouselAssets.whatsapp, [['apps_wa_prioridades', 'Fila quente'], ['apps_wa_followup', 'Follow-ups'], ['apps_wa_resumo', 'Resumo']]],
    sector_sites: ['Sites e Conversao', carouselAssets.conteudo, [['site_revisar', 'Revisar pagina'], ['site_publicar', 'Publicar'], ['@warroom', 'War Room']]],
    sector_automacoes: ['Automacoes', carouselAssets.automacoes, [['apps_auto_desempenho', 'Auditar'], ['apps_auto_falhas', 'Falhas'], ['apps_auto_criar', 'Criar fluxo']]],
    sector_financeiro: ['Financeiro e Dados', carouselAssets.google, [['apps_financeiro_entradas', 'Entradas'], ['apps_financeiro_atrasos', 'Atrasos'], ['apps_financeiro_caixa', 'Projetar']]],
  };
  const def = map[id];
  if (!def) return null;
  const [title, image, buttons] = def;
  const sectorCategory = {
    sector_receita: 'receita',
    sector_crescimento: 'crescimento',
    sector_conteudo: 'conteudo',
    sector_atendimento: 'atendimento',
    sector_sites: 'sites',
    sector_automacoes: 'automacoes',
    sector_financeiro: 'financeiro',
  }[id];
  const specialist = specialistForAction(id, sectorCategory);
  return carousel(`${title} aberto em modo cockpit.`, [
    {
      image,
      category: sectorCategory,
      text: `*${title}*\n━━━━━━━━━━━━\nAqui eu nao mostro departamento; eu mostro o que pode ser movido.\nEscolha uma acao e eu continuo em carrossel com diagnostico, fonte ou confirmacao.`,
      buttons,
    },
    specialistCard(specialist, title),
    {
      image: carouselAssets.empresa,
      categories: ['ceo', 'radar'],
      text: '*Conexao de Fontes*\n━━━━━━━━━━━━\nSe a fonte real ainda nao estiver ligada, eu assumo isso claramente e abro o caminho de conexao.\n👉 Sem inventar dado; com proximo passo.',
      buttons: [['@apps', 'Ver apps'], ['@radar', 'Radar'], ['@empresa', 'Inicio']],
    },
  ], chatid);
}

function missionDetailCarousel(id, chatid = null) {
  const names = {
    mission_leads: 'Recuperar Leads Parados',
    mission_ads: 'Revisar Campanhas',
    mission_conteudo: 'Lancar Conteudo da Semana',
    mission_atendimento: 'Arrumar Atendimento',
    mission_rotina: 'Criar Rotina Automatica',
  };
  const title = names[id] || 'Missao Operacional';
  const specialist = specialistForAction(id, {
    mission_leads: 'receita',
    mission_ads: 'crescimento',
    mission_conteudo: 'conteudo',
    mission_atendimento: 'atendimento',
    mission_rotina: 'automacoes',
  }[id] || 'radar');
  return carousel(`${title}. Montei a missao em passos acionaveis.`, [
    {
      image: carouselAssets.empresa,
      categories: ['radar', 'ceo'],
      text: `*${title}*\n━━━━━━━━━━━━\n1. Diagnosticar sinal.\n2. Escolher fonte.\n3. Preparar acao.\n4. Confirmar execucao.\n👉 A missao vira uma sequencia de carrosseis, nao uma lista solta.`,
      buttons: [['@radar', 'Diagnosticar'], ['@apps', 'Escolher app'], ['confirm_sensitive', 'Ver confirmacao']],
    },
    specialistCard(specialist, title),
    {
      image: carouselAssets.automacoes,
      category: 'automacoes',
      text: '*Transformar em rotina*\n━━━━━━━━━━━━\nSe essa missao se repetir, ela pode virar check-in recorrente.\n👉 A Empresa.ia acompanha e traz quando importa.',
      buttons: [['@rotinas', 'Criar rotina'], ['routine_adjust', 'Ajustar'], ['@warroom', 'War Room']],
    },
  ], chatid);
}

function routineDetailCarousel(id, chatid = null) {
  const labels = {
    routine_daily: 'Briefing Diario',
    routine_sales: 'Radar Comercial',
    routine_ads: 'Revisao de Campanha',
    routine_content: 'Pulso de Conteudo',
    routine_auto: 'Alerta de Automacao',
    routine_adjust: 'Ajuste de Rotina',
  };
  const title = labels[id] || 'Rotina Empresa.ia';
  const specialist = specialistForAction(id, {
    routine_sales: 'receita',
    routine_ads: 'crescimento',
    routine_content: 'conteudo',
    routine_auto: 'automacoes',
    routine_daily: 'ceo',
    routine_adjust: 'radar',
  }[id] || 'radar');
  return carousel(`${title}.`, [
    {
      image: carouselAssets.empresa,
      categories: ['radar', 'automacoes'],
      text: `*${title}*\n━━━━━━━━━━━━\nPara ativar de verdade eu preciso de horario, fonte e regra de aprovacao.\n👉 Primeiro eu preparo a rotina; depois confirmo antes de gravar.`,
      buttons: [['routine_adjust', 'Configurar'], ['@radar', 'Ver exemplo'], ['@empresa', 'Inicio']],
    },
    specialistCard(specialist, title),
  ], chatid);
}

function setupCarousel(id, chatid = null) {
  const title = {
    connect_crm: 'Conectar CRM',
    connect_instagram: 'Conectar Instagram',
    connect_ads: 'Conectar Ads',
    connect_whatsapp: 'WhatsApp Conectado',
    connect_automation: 'Conectar Automacoes',
    connect_finance: 'Conectar Financeiro',
    draft_followups: 'Rascunhar Follow-ups',
    draft_content: 'Rascunhar Conteudo',
    confirm_sensitive: 'Confirmacao Segura',
    automation_brief: 'Brief de Automacao',
    site_revisar: 'Revisar Pagina',
    site_publicar: 'Publicar Pagina',
  }[id] || 'Proximo Passo';
  const specialist = specialistForAction(id);
  return carousel(`${title}.`, [
    {
      image: carouselAssets.empresa,
      categories: ['radar', 'ceo'],
      text: `*${title}*\n━━━━━━━━━━━━\nEsta etapa prepara a execucao sem fingir dado que nao existe.\nSe precisar de fonte, eu peço a conexao. Se mexer fora do WhatsApp, eu peço confirmacao.\n👉 Confiança antes de automacao.`,
      buttons: [['@apps', 'Voltar apps'], ['@setores', 'Setores'], ['@empresa', 'Inicio']],
    },
    specialistCard(specialist, title),
  ], chatid);
}

function empresaiaResponseFor(text, isOwner = false, chatid = null) {
  const key = String(text || '').trim().toLowerCase();
  // detalhe de uma especialista (botão "employee_<id>")
  if (key.startsWith('employee_')) return employeeDetailCarousel(key.replace(/^employee_/, ''), chatid);
  // comandos explícitos (pull): só abrem painel quando o usuário pede de propósito
  const commandMap = new Map([
    ['@empresa', () => vitrineCarousel(chatid)],
    ['empresa', () => vitrineCarousel(chatid)],
    ['@equipe', () => vitrineCarousel(chatid)],
    ['equipe', () => vitrineCarousel(chatid)],
    ['@funcionarios', () => vitrineCarousel(chatid)],
    ['funcionarios', () => vitrineCarousel(chatid)],
    ['@relatorio', () => relatorioCarousel(chatid)],
    ['relatorio', () => relatorioCarousel(chatid)],
    ['@resumo', () => relatorioCarousel(chatid)],
    ['resumo', () => relatorioCarousel(chatid)],
    ['@resumododia', () => relatorioCarousel(chatid)],
    ['@conectar', () => conectarCarousel(chatid)],
    ['conectar', () => conectarCarousel(chatid)],
    ['@ferramentas', () => conectarCarousel(chatid)],
    ['@apps', () => vitrineCarousel(chatid)],
    ['apps', () => vitrineCarousel(chatid)],
    ['@cockpit', () => vitrineCarousel(chatid)],
  ]);
  if (commandMap.has(key)) return commandMap.get(key)();
  // painel de leads capturados (só dono)
  if ((key === '@leads' || key === 'leads' || key === '@prospects') && isOwner) return leadsResumo();
  // pull-only: texto livre NÃO empurra menu — vai pro agente (Sofia conversa)
  return null;
}

async function sendGroupInteractivePrivately(inst, groupChatid, data, part) {
  const target = extractSenderChatid(data);
  if (!target) {
    await sendText(inst, groupChatid, 'Esse painel abre melhor no privado. Me chama no direct e eu te entrego os botoes ali.');
    log(`[${inst.id}] menu/${part.type} grupo sem remetente privado -> ${groupChatid}`);
    return 1;
  }
  const sent = await sendPart(inst, target, part);
  if (sent) {
    await sendText(inst, groupChatid, 'Te chamei no privado. Os botoes estao la, porque grupo nao aceita painel interativo.');
    log(`[${inst.id}] menu/${part.type} redirecionado grupo ${groupChatid} -> privado ${target}`);
    return sent;
  }
  await sendText(inst, groupChatid, 'Tentei abrir o painel no privado, mas o WhatsApp não deixou agora. Me chama no direct que eu continuo por lá.');
  return 0;
}
// ---------- captador de leads (mini-CRM dos prospects) ----------
const LEADS_FILE = process.env.LEADS_FILE || '/opt/empresa-ia/leads.json';
const LEAD_FIELDS = ['nome', 'empresa', 'ramo', 'tamanho', 'canais', 'dor', 'volume', 'ferramentas', 'objetivo', 'orcamento', 'status', 'temperatura', 'notas'];
function loadLeads() { try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return {}; } }
function saveLeads(o) { try { fs.writeFileSync(LEADS_FILE, JSON.stringify(o, null, 2)); } catch (e) { log('[leads] save erro: ' + e.message); } }
function upsertLead(chatid, data) {
  const key = onlyDigits(chatid);
  if (!key) return null;
  const all = loadLeads();
  const prev = all[key] || { chatid: key, criado: new Date().toISOString() };
  const clean = {};
  for (const k of LEAD_FIELDS) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).trim()) clean[k] = String(v).trim().slice(0, 400);
  }
  all[key] = { ...prev, ...clean, atualizado: new Date().toISOString() };
  saveLeads(all);
  return all[key];
}
function leadsResumo() {
  const all = loadLeads();
  const arr = Object.values(all).sort((a, b) => String(b.atualizado || '').localeCompare(String(a.atualizado || '')));
  if (!arr.length) return 'Nenhum lead capturado ainda. Assim que alguem novo conversar, eu vou montando o perfil da empresa aqui.';
  const emoji = (t) => /quent|hot|🔥/i.test(t || '') ? '🔥' : /morn|warm/i.test(t || '') ? '🟡' : /fri|cold|perd/i.test(t || '') ? '🧊' : '•';
  const linhas = arr.slice(0, 20).map((l) => {
    const head = `${emoji(l.temperatura || l.status)} *${l.empresa || l.nome || ('+' + l.chatid)}*`;
    const bits = [l.ramo, l.dor && ('dor: ' + l.dor), l.canais && ('canais: ' + l.canais), l.volume, l.ferramentas && ('usa: ' + l.ferramentas), l.objetivo && ('quer: ' + l.objetivo), l.status].filter(Boolean).map(s => String(s).slice(0, 80));
    return head + (l.nome && l.empresa ? ` — ${l.nome}` : '') + '\n   ' + (bits.join(' · ') || 'sem detalhes ainda') + `\n   📱 +${l.chatid}`;
  });
  return `*Leads capturados (${arr.length})*\n━━━━━━━━━━━━\n` + linhas.join('\n\n');
}

// ---------- Duda: olhos no WhatsApp PESSOAL do dono (instância própria, só leitura) ----------
const PERSONAL_UAZ_SERVER = (process.env.PERSONAL_UAZ_SERVER || '').replace(/\/+$/, '');
const PERSONAL_UAZ_TOKEN = process.env.PERSONAL_UAZ_TOKEN || '';
const personalUaz = () => axios.create({
  baseURL: PERSONAL_UAZ_SERVER,
  headers: { token: PERSONAL_UAZ_TOKEN, 'Content-Type': 'application/json' },
  timeout: 20000,
});
const temZapPessoal = () => !!(PERSONAL_UAZ_SERVER && PERSONAL_UAZ_TOKEN);

function _linhaChat(c) {
  const id = String(c.wa_chatid || c.chatid || c.id || '');
  const nome = c.wa_contactName || c.name || c.wa_name || c.lead_name || onlyDigits(id) || '?';
  const unread = Number(c.wa_unreadCount ?? c.unreadCount ?? 0) || 0;
  let last = String(c.wa_lastMessageText || c.lastMessageText || c.lastMessage?.text || '').replace(/\s+/g, ' ').slice(0, 90);
  let ts = Number(c.wa_lastMsgTimestamp || c.lastMessageTimestamp || 0) || 0;
  if (ts && ts < 1e12) ts *= 1000;
  const quando = ts ? new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const grupo = /@g\.us/.test(id) ? ' [grupo]' : '';
  return `- ${nome}${grupo}${unread ? ` (🔴 ${unread} não lida${unread > 1 ? 's' : ''})` : ''}${quando ? ` · ${quando}` : ''}${last ? `: ${last}` : ''}`;
}

// visão geral: últimos chats do zap pessoal, não lidas primeiro (o que a Duda "enxerga" sempre)
async function snapshotZapPessoal(limit = 20) {
  if (!temZapPessoal()) return '';
  try {
    const { data } = await personalUaz().post('/chat/find', { sort: '-wa_lastMsgTimestamp', limit });
    const chats = Array.isArray(data) ? data : (data?.chats || data?.items || data?.data || []);
    if (!Array.isArray(chats) || !chats.length) return '';
    const naoLidas = chats.filter(c => Number(c.wa_unreadCount ?? c.unreadCount ?? 0) > 0);
    const resto = chats.filter(c => !(Number(c.wa_unreadCount ?? c.unreadCount ?? 0) > 0));
    return [...naoLidas, ...resto].slice(0, limit).map(_linhaChat).join('\n');
  } catch (e) {
    stats.errors++;
    log('[duda] snapshot zap pessoal falhou:', e.response?.status || e.message);
    return '';
  }
}

// lê uma conversa específica do zap pessoal (por número ou por nome aproximado)
async function lerConversaPessoal(quem, limit = 30) {
  if (!temZapPessoal()) return '';
  try {
    let chatid = '';
    const digits = onlyDigits(quem);
    if (digits.length >= 10) {
      chatid = `${digits}@s.whatsapp.net`;
    } else {
      const { data } = await personalUaz().post('/chat/find', { sort: '-wa_lastMsgTimestamp', limit: 100 });
      const chats = Array.isArray(data) ? data : (data?.chats || data?.items || data?.data || []);
      const alvo = String(quem).toLowerCase();
      const m = (chats || []).find(c => String(c.wa_contactName || c.name || c.wa_name || c.lead_name || '').toLowerCase().includes(alvo));
      if (m) chatid = String(m.wa_chatid || m.chatid || m.id || '');
    }
    if (!chatid) return '';
    const { data: md } = await personalUaz().post('/message/find', { chatid, limit });
    const msgs = Array.isArray(md) ? md : (md?.messages || md?.items || md?.data || []);
    const linhas = [];
    for (const m of (msgs || [])) {
      if (!m || typeof m !== 'object') continue;
      const txt = String(m.text || m.body || m.caption || m.content || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.startsWith('{')) continue;
      linhas.push(`${m.fromMe ? 'Fellipe' : (m.senderName || m.pushName || 'Contato')}: ${txt.slice(0, 200)}`);
    }
    return linhas.slice(-limit).join('\n');
  } catch (e) {
    stats.errors++;
    log('[duda] ler conversa falhou:', e.response?.status || e.message);
    return '';
  }
}

// ---------- grupos de RELATÓRIO do dono: feed de interações e de ligações ----------
const REPORT_GROUPS_FILE = process.env.REPORT_GROUPS_FILE || '/opt/empresa-ia/report-groups.json';
function loadReportGroups() { try { return JSON.parse(fs.readFileSync(REPORT_GROUPS_FILE, 'utf8')); } catch { return {}; } }
function isReportGroup(chatid) {
  const g = loadReportGroups();
  const d = onlyDigits(chatid);
  return !!d && Object.values(g).some(j => onlyDigits(j) === d);
}
async function criarGruposRelatorio(inst) {
  const g = loadReportGroups();
  const participants = OWNER.map(onlyDigits).filter(Boolean);
  const defs = [
    ['interacoes', '📊 Interações · Empresa.ia', '📊 Painel de interações ativo! Aqui chega, em tempo real, quem falou com qual funcionária e sobre o quê.'],
    ['ligacoes', '📞 Ligações · Empresa.ia', '📞 Painel de ligações ativo! Aqui chega cada ligação: quem ligou, quem atendeu, assunto e duração.'],
  ];
  for (const [key, name, boasVindas] of defs) {
    if (g[key]) continue;
    try {
      const { data } = await uaz(inst).post('/group/create', { name, participants });
      const grp = data?.group || data;
      const jid = grp?.JID || grp?.jid || grp?.id;
      if (!jid) { log(`[report] criar "${name}" sem JID`); continue; }
      g[key] = jid;
      try { await uaz(inst).post('/group/updateParticipants', { groupjid: jid, action: 'promote', participants }); } catch {}
      try { await uaz(inst).post('/send/text', { number: jid, text: boasVindas }); } catch {}
      log(`[report] grupo ${key} criado: ${jid}`);
    } catch (e) { stats.errors++; log(`[report] criar "${name}" falhou:`, e.response?.status || e.message); }
  }
  try { fs.writeFileSync(REPORT_GROUPS_FILE, JSON.stringify(g, null, 2)); } catch (e) { log('[report] save erro:', e.message); }
  return g;
}
// envia uma linha pro painel (fire-and-forget; relatório NUNCA pode travar o atendimento)
function reportar(inst, key, texto) {
  const jid = loadReportGroups()[key];
  if (!jid) return;
  uaz(inst).post('/send/text', { number: jid, text: texto })
    .catch(e => log('[report] envio falhou:', e.response?.status || e.message));
}
const horaSP = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

// ---------- memória organizacional: o diário que dá VIDA à empresa ----------
// Toda funcionária LÊ e ESCREVE aqui. É o que faz a Helena saber da ligação que a
// Clara atendeu e a voz saber do recado mandado no grupo — uma empresa, uma memória.
const MEMORIA_FILE = process.env.MEMORIA_FILE || '/opt/empresa-ia/memoria-empresa.json';
function loadMemoria() { try { return JSON.parse(fs.readFileSync(MEMORIA_FILE, 'utf8')); } catch { return []; } }
function registrarEvento(tipo, texto, meta = {}) {
  const t = String(texto || '').trim();
  if (!t) return;
  try {
    const eventos = loadMemoria();
    eventos.push({ ts: new Date().toISOString(), tipo: String(tipo || 'fato'), texto: t.slice(0, 300), ...meta });
    while (eventos.length > 600) eventos.shift();
    fs.writeFileSync(MEMORIA_FILE, JSON.stringify(eventos, null, 1));
  } catch (e) { log('[memoria] save erro:', e.message); }
}
function diarioEmpresa({ paraDono = false, chatid = null, limite = 12 } = {}) {
  const eventos = loadMemoria().slice(-250).reverse();
  const digits = chatid ? onlyDigits(chatid) : '';
  const visiveis = eventos.filter(e => paraDono || (digits && e.chatid && onlyDigits(e.chatid) === digits));
  if (!visiveis.length) return '';
  const fmt = visiveis.slice(0, limite).map(e => {
    const quando = new Date(e.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `- ${quando} ${e.funcionaria ? `[${e.funcionaria}] ` : ''}${e.texto}`;
  });
  return `\n[DIÁRIO DA EMPRESA — memória COMPARTILHADA de tudo que aconteceu na operação (vocês todas sabem disso; cite com naturalidade quando for relevante, como colegas que conversam entre si):\n${fmt.join('\n')}\nPara REGISTRAR um fato/decisão/pendência importante: <uazapi-action>{"action":"registrar","texto":"<o fato>","tipo":"fato|pendencia|decisao","funcionaria":"<seu nome>"}</uazapi-action>]`;
}

// ---------- Bia: Instagram de verdade (Meta Graph API) ----------
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN || '';
const META_IG_ID = process.env.META_IG_ID || '';
const META_PAGE_ID = process.env.META_PAGE_ID || '';
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const temInstagram = () => !!(META_PAGE_TOKEN && META_IG_ID);
const metaGet = (path, params = {}) =>
  axios.get(`${GRAPH_BASE}/${path}`, { params: { ...params, access_token: META_PAGE_TOKEN }, timeout: 20000 });
const metaPost = (path, params = {}) =>
  axios.post(`${GRAPH_BASE}/${path}`, null, { params: { ...params, access_token: META_PAGE_TOKEN }, timeout: 60000 });
const _metaErr = (e) => `${e.response?.status || ''} ${JSON.stringify(e.response?.data?.error?.message || e.message).slice(0, 160)}`;

// visão do Instagram que a Bia "enxerga": perfil + desempenho dos últimos posts
async function snapshotInstagram() {
  if (!temInstagram()) return '';
  try {
    const [{ data: perfil }, { data: medias }] = await Promise.all([
      metaGet(META_IG_ID, { fields: 'username,followers_count,media_count' }),
      metaGet(`${META_IG_ID}/media`, { fields: 'id,caption,media_type,like_count,comments_count,timestamp,permalink', limit: 6 }),
    ]);
    const linhas = [`@${perfil.username} · ${perfil.followers_count} seguidores · ${perfil.media_count} posts`];
    for (const m of (medias.data || [])) {
      const cap = String(m.caption || '').replace(/\s+/g, ' ').slice(0, 60);
      linhas.push(`- ${String(m.timestamp || '').slice(0, 10)} ${m.media_type} ❤️${m.like_count ?? 0} 💬${m.comments_count ?? 0}${cap ? ` — ${cap}` : ''}`);
    }
    return linhas.join('\n');
  } catch (e) { stats.errors++; log('[bia] snapshot IG falhou:', _metaErr(e)); return ''; }
}

// publica foto no feed (fluxo oficial: container -> publish). imageUrl precisa ser público.
async function igPublicar(imageUrl, caption) {
  const { data: c } = await metaPost(`${META_IG_ID}/media`, { image_url: imageUrl, caption: caption || '' });
  if (!c?.id) throw new Error('container sem id');
  const { data: p } = await metaPost(`${META_IG_ID}/media_publish`, { creation_id: c.id });
  if (!p?.id) throw new Error('publish sem id');
  try {
    const { data: m } = await metaGet(p.id, { fields: 'permalink' });
    return { id: p.id, permalink: m?.permalink || '' };
  } catch { return { id: p.id, permalink: '' }; }
}

// publica REEL (vídeo) no feed. videoUrl precisa ser público. Fluxo: container -> poll status -> publish.
async function igPublicarReel(videoUrl, caption, capaUrl = '') {
  const params = { media_type: 'REELS', video_url: videoUrl, caption: caption || '', share_to_feed: 'true' };
  if (capaUrl) params.thumb_offset = '0';
  const { data: c } = await metaPost(`${META_IG_ID}/media`, params);
  if (!c?.id) throw new Error('container REELS sem id');
  // espera o vídeo terminar de processar (status FINISHED), até ~3min
  for (let i = 0; i < 30; i++) {
    await sleep(6000);
    try {
      const { data: st } = await metaGet(c.id, { fields: 'status_code,status' });
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR') throw new Error('processamento do reel falhou: ' + (st.status || ''));
    } catch (e) { if (i > 25) throw e; }
  }
  const { data: p } = await metaPost(`${META_IG_ID}/media_publish`, { creation_id: c.id });
  if (!p?.id) throw new Error('publish REELS sem id');
  try { const { data: m } = await metaGet(p.id, { fields: 'permalink' }); return { id: p.id, permalink: m?.permalink || '' }; }
  catch { return { id: p.id, permalink: '' }; }
}

async function igComentariosRecentes(limit = 12) {
  const { data: medias } = await metaGet(`${META_IG_ID}/media`,
    { fields: 'id,caption,comments.limit(8){id,text,username,timestamp}', limit: 5 });
  const linhas = [];
  for (const m of (medias.data || [])) {
    const cap = String(m.caption || '').replace(/\s+/g, ' ').slice(0, 35);
    for (const cm of (m.comments?.data || [])) {
      linhas.push(`[${cm.id}] @${cm.username} em "${cap}...": ${String(cm.text || '').slice(0, 120)}`);
    }
  }
  return linhas.slice(0, limit).join('\n');
}

const igResponderComentario = (commentId, message) => metaPost(`${commentId}/replies`, { message });
// DM automática pra quem comentou (permissão instagram_manage_messages) — fecha o funil dentro do IG
const igEnviarDM = (igUserId, text) =>
  metaPost(`${META_IG_ID}/messages`, { recipient: JSON.stringify({ id: igUserId }), message: JSON.stringify({ text }) });

// ---------- automação de comentários: palavra-chave → resposta + DM (o funil "comenta MAPA") ----------
// Regras por palavra-chave: { gatilho, respostaPublica, dm }. Editável em runtime via arquivo.
const AUTOREPLY_FILE = process.env.AUTOREPLY_FILE || '/opt/empresa-ia/ig-autoreply.json';
function loadAutoreply() {
  try { return JSON.parse(fs.readFileSync(AUTOREPLY_FILE, 'utf8')); }
  catch {
    return {
      regras: [{
        gatilho: 'mapa',
        respostaPublica: 'Acabei de te mandar no direct 📩 corre lá!',
        dm: 'Opa! Vi que você comentou MAPA 🗺️\n\nMontei um diagnóstico de onde a IA deixa de ser ferramenta e vira infraestrutura de crescimento no seu negócio. Me conta: o que você faz hoje? Já te mostro por onde começar. 🚀',
      }],
    };
  }
}
const autoreplyVistos = new Set(); // comment_ids já respondidos (anti-duplicata em memória)
function startIgAutoreply() {
  if (!temInstagram()) return;
  const INTERVALO = parseInt(process.env.IG_AUTOREPLY_MS || '120000', 10); // 2min
  if (INTERVALO <= 0) return;
  setInterval(async () => {
    try {
      const cfg = loadAutoreply();
      if (!cfg.regras?.length) return;
      const { data: medias } = await metaGet(`${META_IG_ID}/media`,
        { fields: 'id,comments.limit(15){id,text,username,from,timestamp}', limit: 8 });
      for (const m of (medias.data || [])) {
        for (const cm of (m.comments?.data || [])) {
          if (autoreplyVistos.has(cm.id)) continue;
          const texto = String(cm.text || '').toLowerCase();
          const regra = cfg.regras.find(r => texto.includes(String(r.gatilho || '').toLowerCase()));
          if (!regra) continue;
          autoreplyVistos.add(cm.id);
          if (regra.respostaPublica) { try { await igResponderComentario(cm.id, regra.respostaPublica); } catch (e) { log('[autoreply] reply:', _metaErr(e)); } }
          const uid = cm.from?.id;
          if (regra.dm && uid) { try { await igEnviarDM(uid, regra.dm); } catch (e) { log('[autoreply] dm:', _metaErr(e)); } }
          registrarEvento('autoreply', `comentário "${regra.gatilho}" de @${cm.username} → resposta+DM automática`, { funcionaria: 'Bia' });
          reportar(getInstForReport(), 'interacoes', `🤖 ${horaSP()} · @${cm.username} comentou *${regra.gatilho.toUpperCase()}* no Instagram → resposta + DM enviadas`);
          log(`[autoreply] ${regra.gatilho} → @${cm.username} (${cm.id})`);
        }
      }
      if (autoreplyVistos.size > 4000) { const arr = [...autoreplyVistos]; autoreplyVistos.clear(); arr.slice(-2000).forEach(x => autoreplyVistos.add(x)); }
    } catch (e) { log('[autoreply] ciclo:', _metaErr(e)); }
  }, INTERVALO).unref?.();
  log(`[autoreply] vigilância de comentários ativa (${INTERVALO / 1000}s)`);
}
function getInstForReport() { return CFG[0]; }

// ---------- relatório diário de métricas: "está valendo?" (a Bia analisa) ----------
const METRICAS_FILE = process.env.METRICAS_FILE || '/opt/empresa-ia/metricas-historico.json';
const RELATORIO_HORA = parseInt(process.env.RELATORIO_HORA || '20', 10); // 20h SP; -1 desliga
let _lastRelatorioDay = '';

async function coletarMetricas() {
  if (!temInstagram()) return null;
  try {
    const [{ data: perfil }, { data: medias }] = await Promise.all([
      metaGet(META_IG_ID, { fields: 'followers_count,media_count' }),
      metaGet(`${META_IG_ID}/media`, { fields: 'id,timestamp,media_type,like_count,comments_count,permalink,caption', limit: 12 }),
    ]);
    // alcance/visualizações dos posts recentes (insights por mídia)
    const posts = [];
    for (const m of (medias.data || []).slice(0, 9)) {
      let reach = 0, views = 0;
      try {
        const { data: ins } = await metaGet(`${m.id}/insights`, { metric: 'reach,views' });
        for (const it of (ins || [])) {
          const v = it.values?.[0]?.value || 0;
          if (it.name === 'reach') reach = v; if (it.name === 'views') views = v;
        }
      } catch {}
      posts.push({ id: m.id, ts: m.timestamp, tipo: m.media_type, likes: m.like_count || 0, coments: m.comments_count || 0, reach, views, link: m.permalink });
    }
    return { followers: perfil.followers_count, mediaCount: perfil.media_count, posts };
  } catch (e) { log('[metricas] coleta falhou:', _metaErr(e)); return null; }
}

// gera um card PNG na identidade Saraiva.AI (preto/azul/branco) via ImageMagick. Devolve a URL pública.
const { execFile } = require('child_process');
function gerarCard(slug, { etiqueta, numero, sub, rodape }) {
  return new Promise((resolve) => {
    const dir = `${PUBLIC_DIR}/cards`;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const out = `${dir}/${slug}.png`;
    const esc = s => String(s == null ? '' : s).replace(/"/g, '\\"');
    const args = ['-size', '1080x1080', 'xc:#000006',
      '-gravity', 'north', '-fill', '#8A94A6', '-font', 'DejaVu-Sans', '-pointsize', '42',
      '-annotate', '+0+110', esc(etiqueta),
      '-gravity', 'center', '-fill', '#008CFC', '-font', 'DejaVu-Sans-Bold', '-pointsize', '180',
      '-annotate', '+0-30', esc(numero),
      '-gravity', 'center', '-fill', '#F0F0F0', '-font', 'DejaVu-Sans', '-pointsize', '50',
      '-annotate', '+0+170', esc(sub),
      '-gravity', 'south', '-fill', '#008CFC', '-font', 'DejaVu-Sans-Bold', '-pointsize', '36',
      '-annotate', '+0+80', esc(rodape || 'SARAIVA.AI'),
      out];
    execFile('convert', args, { timeout: 20000 }, (err) => {
      if (err) { log('[card] gerar falhou:', err.message); return resolve(''); }
      resolve(`${ASSET_BASE}cards/${slug}.png`);
    });
  });
}

async function enviarRelatorioMetricas(inst, motivo = 'cron') {
  const m = await coletarMetricas();
  if (!m) return false;
  // histórico p/ comparar dia-a-dia (crescimento de seguidores, tendência)
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(METRICAS_FILE, 'utf8')); } catch {}
  const ontem = hist.length ? hist[hist.length - 1] : null;
  const hoje = { dia: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), followers: m.followers, ts: new Date().toISOString() };
  if (!ontem || ontem.dia !== hoje.dia) { hist.push(hoje); while (hist.length > 90) hist.shift(); try { fs.writeFileSync(METRICAS_FILE, JSON.stringify(hist, null, 1)); } catch {} }
  const deltaSeg = ontem ? m.followers - ontem.followers : 0;
  // hoje: posts das últimas 24h
  const agora = Date.now();
  const recentes = m.posts.filter(p => agora - new Date(p.ts).getTime() < 26 * 3600 * 1000);
  const top = [...m.posts].sort((a, b) => (b.reach + b.likes * 3) - (a.reach + a.likes * 3))[0];
  // pede pra Bia interpretar (não só despejar número) — leitura honesta de "vale a pena?"
  const dados = `Seguidores: ${m.followers} (${deltaSeg >= 0 ? '+' : ''}${deltaSeg} vs ontem). Posts hoje: ${recentes.length}.\n`
    + 'Desempenho dos últimos posts (reach/views/likes/coments):\n'
    + m.posts.slice(0, 6).map(p => `- ${String(p.ts).slice(5, 10)} ${p.tipo}: ${p.reach} alcance, ${p.views} views, ${p.likes} likes, ${p.coments} coments`).join('\n')
    + (top ? `\nMelhor post recente: ${top.reach} de alcance (${top.link})` : '');
  const prompt = `[RELATÓRIO DIÁRIO — você é a Bia, de redes sociais, prestando contas pro Fellipe sobre o Instagram. `
    + `Dados REAIS de hoje:\n${dados}\n`
    + `Escreva o relatório do dia pra ele: comece com *Bia · Redes Sociais* em negrito. `
    + `(1) números do dia em 1-2 linhas (seguidores +/-, posts), (2) o que está funcionando e o que não (seja HONESTA — se o alcance está baixo, diga), `
    + `(3) 1 recomendação prática pra amanhã (horário, tema ou formato que rendeu mais). `
    + `Tom direto de quem cuida do crescimento, sem encher linguiça. Sem markdown além do negrito do nome.]`;
  const dest = _grupoRelatorioOuDono('interacoes');
  try {
    // 1) a Bia interpreta os números (leitura honesta) -> vira a legenda do carrossel
    let leitura = '';
    try { const reply = await runAgent(sessionKeyFor(dest), prompt); leitura = parseAgentReply(reply).parts.filter(p => typeof p === 'string').join('\n').trim(); } catch {}

    // 2) gera os cards visuais (identidade Saraiva.AI)
    const totReach = m.posts.reduce((s, p) => s + (p.reach || 0), 0);
    const totEng = m.posts.reduce((s, p) => s + (p.likes || 0) + (p.coments || 0), 0);
    const dd = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
    const stamp = Date.now().toString(36);
    const cards = await Promise.all([
      gerarCard(`rel-seg-${stamp}`, { etiqueta: `RELATÓRIO ${dd}`, numero: String(m.followers), sub: `seguidores (${deltaSeg >= 0 ? '+' : ''}${deltaSeg} hoje)`, rodape: 'SARAIVA.AI' }),
      gerarCard(`rel-alc-${stamp}`, { etiqueta: 'ALCANCE (últimos posts)', numero: totReach >= 1000 ? (totReach / 1000).toFixed(1) + 'k' : String(totReach), sub: 'pessoas alcançadas', rodape: 'SARAIVA.AI' }),
      gerarCard(`rel-eng-${stamp}`, { etiqueta: 'ENGAJAMENTO', numero: String(totEng), sub: 'curtidas + comentários', rodape: 'SARAIVA.AI' }),
      gerarCard(`rel-post-${stamp}`, { etiqueta: 'POSTS HOJE', numero: String(recentes.length), sub: top ? `melhor: ${top.reach} alcance` : 'no ar', rodape: 'SARAIVA.AI' }),
    ]);
    const validos = cards.filter(Boolean);
    let sent = 0;
    if (validos.length >= 2) {
      const legenda = leitura || `📊 Relatório do dia — ${m.followers} seguidores (${deltaSeg >= 0 ? '+' : ''}${deltaSeg}).`;
      const carrossel = {
        carousel: validos.map((url, i) => ({ text: i === 0 ? legenda.slice(0, 1024) : '', image: url, buttons: [] })),
        readchat: true, delay: 0,
      };
      sent = (await sendPart(inst, dest, carrossel)) || 0;
      if (!sent && leitura) { await sendText(inst, dest, leitura); sent = 1; } // fallback texto
    } else {
      // sem cards (ImageMagick falhou) -> texto puro
      if (leitura) { await sendText(inst, dest, leitura); sent = 1; }
    }
    registrarEvento('metricas', `relatório diário (carrossel): ${m.followers} seguidores (${deltaSeg >= 0 ? '+' : ''}${deltaSeg}), ${recentes.length} posts hoje`, { funcionaria: 'Bia' });
    log(`[metricas] relatório carrossel (${motivo}) -> ${dest}: ${validos.length} cards, sent=${sent}`);
    return sent > 0;
  } catch (e) { stats.errors++; log('[metricas] relatório falhou:', e.message); return false; }
}
function _grupoRelatorioOuDono(key) {
  const g = loadReportGroups()[key];
  return g || (OWNER[0] ? `${OWNER[0]}@s.whatsapp.net` : '');
}
function startRelatorioMetricas(inst) {
  if (RELATORIO_HORA < 0 || !temInstagram()) return;
  setInterval(() => {
    const sp = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    if (sp.getHours() !== RELATORIO_HORA) return;
    const dia = `${sp.getFullYear()}-${sp.getMonth() + 1}-${sp.getDate()}`;
    if (_lastRelatorioDay === dia) return;
    _lastRelatorioDay = dia;
    enviarRelatorioMetricas(inst, 'cron').catch(e => log('[metricas] erro:', e.message));
  }, 60 * 1000).unref?.();
  log(`[metricas] relatório diário agendado para ${RELATORIO_HORA}h (SP)`);
}

// ---------- agendador de Reels: a Bia publica os vídeos no horário certo ----------
// Fila persistente (scheduled-posts.json): {id, videoUrl, caption, quando(ISO), status, gatilho}.
// Cron de 1min publica o que está vencido. Tudo reportado no painel + diário.
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || '/opt/empresa-ia/scheduled-posts.json';
function loadSchedule() { try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return []; } }
function saveSchedule(arr) { try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(arr, null, 1)); } catch (e) { log('[agenda] save erro:', e.message); } }
let _publicando = false;
function startAgendador(inst) {
  if (!temInstagram()) return;
  setInterval(async () => {
    if (_publicando) return;
    const fila = loadSchedule();
    const agora = Date.now();
    const prox = fila.find(p => p.status === 'pendente' && new Date(p.quando).getTime() <= agora);
    if (!prox) return;
    _publicando = true;
    try {
      log(`[agenda] publicando: ${prox.id} (${prox.videoUrl})`);
      const r = await igPublicarReel(prox.videoUrl, prox.caption);
      prox.status = 'publicado'; prox.permalink = r.permalink; prox.publishedId = r.id;
      registrarEvento('instagram', `Reel publicado: ${(prox.caption || '').slice(0, 60)}${r.permalink ? ' ' + r.permalink : ''}`, { funcionaria: 'Bia' });
      reportar(inst, 'interacoes', `📸 ${horaSP()} · *Bia* publicou um Reel no Instagram${r.permalink ? `\n${r.permalink}` : ''}`);
      if (OWNER[0]) { try { await uaz(inst).post('/send/text', { number: `${OWNER[0]}@s.whatsapp.net`, text: `📸 Acabei de publicar no Instagram!${r.permalink ? `\n${r.permalink}` : ''}\n\n_Bia · Redes Sociais_` }); } catch {} }
    } catch (e) {
      prox.status = 'erro'; prox.erro = _metaErr(e); prox.tentativas = (prox.tentativas || 0) + 1;
      if (prox.tentativas < 3) prox.status = 'pendente'; // re-tenta no próximo ciclo
      log(`[agenda] falha ao publicar ${prox.id}:`, _metaErr(e));
      if (prox.status === 'erro' && OWNER[0]) { try { await uaz(inst).post('/send/text', { number: `${OWNER[0]}@s.whatsapp.net`, text: `⚠️ Não consegui publicar um Reel agendado (${prox.id}). Erro: ${prox.erro}` }); } catch {} }
    } finally {
      saveSchedule(fila);
      _publicando = false;
    }
  }, 60 * 1000).unref?.();
  const pend = loadSchedule().filter(p => p.status === 'pendente').length;
  log(`[agenda] agendador de Reels ativo (${pend} post(s) na fila)`);
}

// ---------- Duda: digest matinal do zap pessoal (proativa, não só consulta) ----------
const DUDA_DIGEST_HOUR = parseInt(process.env.DUDA_DIGEST_HOUR || '8', 10); // hora SP; -1 desliga
let _lastDigestDay = '';

function _grupoDaDuda() {
  const emps = loadGroupEmps();
  const k = Object.keys(emps).find(key => emps[key] === 'duda');
  if (!k) return null;
  return k.includes('@') ? k : `${k}@g.us`;
}

async function enviarDigestDuda(motivo = 'cron') {
  if (!temZapPessoal()) return false;
  const dest = _grupoDaDuda() || (OWNER[0] ? `${OWNER[0]}@s.whatsapp.net` : null);
  if (!dest) { log('[duda] digest: sem destino (nem grupo nem dono)'); return false; }
  const snap = await snapshotZapPessoal(25);
  if (!snap) { log('[duda] digest: snapshot vazio, pulando'); return false; }
  const inst = CFG[0];
  const diarioDigest = diarioEmpresa({ paraDono: true, limite: 10 });
  const prompt = `[DIGEST MATINAL — você é a Duda, gestora do WhatsApp PESSOAL do Fellipe. `
    + `Visão AO VIVO do zap dele agora:\n${snap}\n`
    + (diarioDigest ? `${diarioDigest}\n` : '')
    + `Escreva o bom-dia gerencial dele: comece com *Duda · WhatsApp Pessoal* em negrito, depois `
    + `(1) o retrato em 1 linha (quantas conversas, quantas não lidas), `
    + `(2) as 3-5 que MERECEM resposta primeiro — nome + por quê em poucas palavras, mais urgente no topo, `
    + `(3) feche oferecendo: "quer que eu rascunhe alguma resposta?". `
    + `Tom de zap, direto, sem markdown além dos negritos. NUNCA invente conversa que não está na visão acima.]`;
  try {
    const reply = await runAgent(sessionKeyFor(dest), prompt);
    const { parts } = parseAgentReply(reply);
    let sent = 0;
    for (const p of parts) sent += (await sendPart(inst, dest, p)) || 0;
    log(`[duda] digest (${motivo}) -> ${dest}: ${sent} msg(s)`);
    return sent > 0;
  } catch (e) { stats.errors++; log('[duda] digest falhou:', e.message); return false; }
}

function startDudaDigest() {
  if (DUDA_DIGEST_HOUR < 0 || !temZapPessoal()) return;
  setInterval(() => {
    const sp = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    if (sp.getHours() !== DUDA_DIGEST_HOUR) return;
    const dia = `${sp.getFullYear()}-${sp.getMonth() + 1}-${sp.getDate()}`;
    if (_lastDigestDay === dia) return;
    _lastDigestDay = dia;
    enviarDigestDuda('cron').catch(e => log('[duda] digest erro:', e.message));
  }, 60 * 1000).unref?.();
  log(`[duda] digest matinal agendado para ${DUDA_DIGEST_HOUR}h (SP)`);
}

// ---------- Roda das Mentes: debate entre as funcionárias em rodadas ----------
// O Fellipe lança uma questão e as especialistas debatem entre si (posições -> atrito -> síntese),
// cada fala como mensagem separada com *Nome · Setor*. Tudo no MESMO cérebro/sessão (consistência).
async function rodaDasMentes(inst, chatid, pergunta, replyId) {
  const sk = sessionKeyFor(chatid);
  const formato = 'Formato OBRIGATÓRIO: um parágrafo por fala (linha em branco entre eles), cada um começando com *Nome · Setor* em NEGRITO. Falas curtas (2-4 linhas), tom WhatsApp, sem markdown além do negrito do nome.';
  const rodadas = [
    `[RODA DAS MENTES — rodada 1/3: POSIÇÕES. A questão da mesa é: "${pergunta}". Escolha as 3 especialistas MAIS relevantes pro tema (sofia gerência, clara vendas, bia redes, maya atendimento, helena financeiro, lara operação, nina rotina, alice onboarding, dani desenvolvimento) e cada uma dá a POSIÇÃO dela — concreta, puxando pro ângulo da SUA área, com personalidade própria. As posições devem ser DIFERENTES entre si. ${formato} Abra com *Sofia · Gerente* apresentando a roda em 1 linha ("🧠 Roda das Mentes aberta: ..."). NÃO conclua nada ainda.]`,
    `[RODA DAS MENTES — rodada 2/3: DEBATE. As mesmas especialistas agora se respondem DE VERDADE: uma rebate a outra pelo nome, aponta furo, defende seu ponto, cede onde faz sentido (ex.: *Clara · Vendas* discorda da Helena e explica por quê). Atrito honesto e respeitoso, 3-4 falas. ${formato} NÃO conclua ainda.]`,
    `[RODA DAS MENTES — rodada 3/3: SÍNTESE. A *Sofia · Gerente* fecha a roda: o que o debate concluiu, a recomendação prática em passos (1, 2, 3) e UM ponto de atenção que sobrou. Termine perguntando ao Fellipe se quer aprofundar algum ângulo ou já partir pra ação. ${formato}]`,
  ];
  for (let i = 0; i < rodadas.length; i++) {
    let reply = '';
    try { reply = await runAgent(sk, rodadas[i]); }
    catch (e) { stats.errors++; log(`[roda] rodada ${i + 1} falhou:`, e.message); }
    if (!reply || !String(reply).trim()) {
      if (i === 0) { await sendText(inst, chatid, 'A roda engasgou antes de começar 🙈 me manda a pergunta de novo?', replyId); return; }
      continue; // rodada do meio falhou -> segue pra síntese mesmo assim
    }
    const { parts } = parseAgentReply(reply);
    for (const p of parts) await sendPart(inst, chatid, p, i === 0 ? replyId : null);
    if (i < rodadas.length - 1) { await setPresence(inst, chatid, 'composing'); await sleep(1800); }
  }
  stats.answered++; stats.lastAnswerAt = new Date().toISOString();
  registrarEvento('roda', `Roda das Mentes debateu: "${String(pergunta).slice(0, 100)}"`, { chatid, funcionaria: 'Sofia' });
  log(`[roda] debate concluído em ${chatid}: ${String(pergunta).slice(0, 60)}`);
}

// ---------- grupo dedicado (funcionária oferece e cria) ----------
const groupGuard = new Map(); // chatid:assunto -> ts (idempotência)
const handoffGuard = new Map(); // grupo -> ts da última troca de porta-voz (anti-ping-pong)
const HANDOFF_COOLDOWN_MS = 8 * 60 * 1000;
const GROUP_GUARD_MS = 5 * 60 * 1000;
// mapa grupo -> funcionária (pra saber QUEM fala em cada grupo)
const GROUP_EMP_FILE = process.env.GROUP_EMP_FILE || '/opt/empresa-ia/group-emps.json';
function loadGroupEmps() { try { return JSON.parse(fs.readFileSync(GROUP_EMP_FILE, 'utf8')); } catch { return {}; } }
function setGroupEmp(jid, empId) { const a = loadGroupEmps(); a[onlyDigits(jid) || jid] = empId; try { fs.writeFileSync(GROUP_EMP_FILE, JSON.stringify(a, null, 2)); } catch (e) { log('[group-emp] save erro: ' + e.message); } }
function getGroupEmp(jid) { const a = loadGroupEmps(); return a[onlyDigits(jid) || jid] || a[jid] || null; }
// porta-voz ATIVA do grupo (pode mudar conforme o assunto) — separada da DONA do grupo,
// senão "assumir" transformaria qualquer grupo em grupo dedicado (responderia tudo sem menção).
const GROUP_SPK_FILE = process.env.GROUP_SPK_FILE || '/opt/empresa-ia/group-speakers.json';
function loadGroupSpeakers() { try { return JSON.parse(fs.readFileSync(GROUP_SPK_FILE, 'utf8')); } catch { return {}; } }
function setGroupSpeaker(jid, empId) { const a = loadGroupSpeakers(); a[onlyDigits(jid) || jid] = empId; try { fs.writeFileSync(GROUP_SPK_FILE, JSON.stringify(a, null, 2)); } catch (e) { log('[group-spk] save erro: ' + e.message); } }
function getGroupSpeaker(jid) { const a = loadGroupSpeakers(); return a[onlyDigits(jid) || jid] || a[jid] || null; }

async function criarGrupoDedicado(inst, emp, assunto, leadChatid) {
  const leadDigits = onlyDigits(leadChatid);
  const participants = [...new Set([leadDigits, ...OWNER])].map(onlyDigits).filter(d => d.length >= 12 && d.length <= 13);
  if (!participants.length) { log('[create_group] sem participantes validos'); return null; }
  const setorLabel = emp.role || emp.category || 'Empresa.ia';
  // nome do grupo CURTO e dinâmico (cabe na lista do WhatsApp): emoji do setor + o assunto.
  const SECTOR_EMOJI = { vendas: '💰', crm: '💰', comercial: '💰', atendimento: '💬', cx: '💬', suporte: '💬', financeiro: '📊', dados: '📊', conteudo: '📱', redes: '📱', marketing: '📣', ads: '📣', operacao: '⚙️', automacoes: '💻', tecnologia: '💻', rotina: '📅', agenda: '📅', estrategia: '🎯', juridico: '⚖️', rh: '👥' };
  const emo = SECTOR_EMOJI[String(emp.category || '').toLowerCase()] || SECTOR_EMOJI[String(emp.role || '').toLowerCase()] || '🟢';
  const tema = String(assunto || setorLabel).trim().replace(/\s+/g, ' ');
  const temaCap = tema.charAt(0).toUpperCase() + tema.slice(1);
  const name = `${emo} ${temaCap}`.slice(0, 32) || 'Empresa.ia';
  let group;
  try {
    const { data } = await uaz(inst).post('/group/create', { name, participants });
    group = data?.group || data;
  } catch (e) {
    stats.errors++;
    log(`[create_group] create falhou:`, e.response?.status || e.message, JSON.stringify(e.response?.data || '').slice(0, 160));
    return null;
  }
  const groupJid = group?.JID || group?.jid || group?.id;
  if (!groupJid) { log('[create_group] sem JID na resposta'); return null; }
  setGroupEmp(groupJid, emp.id); // grava quem é a dona deste grupo
  // o DONO entra como ADMINISTRADOR (o bot é admin por ter criado o grupo)
  try {
    const owners = OWNER.map(onlyDigits).filter(Boolean);
    if (owners.length) await uaz(inst).post('/group/updateParticipants', { groupjid: groupJid, action: 'promote', participants: owners });
    log(`[create_group] dono promovido a admin: ${owners.join(',')}`);
  } catch (e) { log('[create_group] promover admin falhou (segue):', e.response?.status || e.message); }
  // ícone token-free (require lazy: se faltar o módulo, só pula a foto, não derruba o bridge)
  try {
    const { genGroupIcon } = require('./gen-group-icon');
    const iconPath = await genGroupIcon({ employeeId: emp.id, assunto: assunto || setorLabel, setor: emp.category || emp.role });
    await uaz(inst).post('/group/updateImage', { groupjid: groupJid, image: assetUrl(require('path').basename(iconPath)) });
  } catch (e) { log('[create_group] icone/updateImage falhou (segue sem foto):', e.message); }
  // invite link (create pode vir vazio -> /group/info, campo groupjid minúsculo)
  let inviteLink = group?.invite_link || '';
  if (!inviteLink) {
    try {
      const { data: info } = await uaz(inst).post('/group/info', { groupjid: groupJid, getInviteLink: true, force: true });
      inviteLink = (info?.group || info)?.invite_link || '';
    } catch {}
  }
  // avisa o lead direto (sem humanChunks fragmentar o link)
  const linkLine = inviteLink ? `\n\n👉 ${inviteLink}` : '';
  try {
    await uaz(inst).post('/send/text', { number: leadChatid, text: `Prontinho! 🎉 Criei o grupo *${name}* pra gente organizar isso com calma. Te encontro por lá! 🙌${linkLine}` });
  } catch (e) { log('[create_group] aviso ao lead falhou:', e.message); }
  registrarEvento('grupo', `grupo "${name}" criado para o assunto "${assunto || setorLabel}"`, { chatid: groupJid, funcionaria: emp.name });
  log(`[create_group] ok ${emp.id} -> ${groupJid} (${participants.length}p)`);
  return { groupJid, name, inviteLink };
}

async function runAction(inst, action, chatid = null, senderIsOwner = false) {
  try {
    const a = String(action.action || '').toLowerCase();
    if (a.startsWith('send.')) return;
    // a Sofia capturou/atualizou dados da empresa do lead
    if (a === 'lead' || a === 'lead_update') {
      const d = action.data || action.fields || action.lead || action;
      const saved = upsertLead(chatid, d);
      if (saved) { registrarEvento('lead', `lead atualizado (${Object.keys(d).filter(k => LEAD_FIELDS.includes(k)).join(',')})`, { chatid }); log(`[lead] ${onlyDigits(chatid)} <- ${Object.keys(d).filter(k => LEAD_FIELDS.includes(k)).join(',')}`); }
      return;
    }
    // a Sofia decidiu disparar uma ligação proativa
    if (a === 'call' || a === 'call_employee' || a === 'ligar') {
      const emp = employeesById.get(String(action.employee || action.employee_id || action.id || '').toLowerCase());
      if (emp && chatid) { makeEmployeeCall(emp, chatid, {}, action.reason || action.motivo || '').catch(e => log('[call action] ' + e.message)); }
      return;
    }
    // a funcionária ofereceu e o usuário topou: cria grupo dedicado
    if (a === 'create_group' || a === 'group.create' || a === 'criar_grupo') {
      const emp = employeesById.get(String(action.employee_id || action.employee || action.id || '').toLowerCase());
      if (!emp || !chatid) { log('[create_group] employee/chatid invalido'); return; }
      const assunto = String(action.assunto || action.subject || action.tema || action.reason || '').trim();
      const guardKey = `${onlyDigits(chatid)}:${assunto.toLowerCase()}`;
      const last = groupGuard.get(guardKey);
      if (last && Date.now() - last < GROUP_GUARD_MS) { log('[create_group] duplicado ignorado'); return; }
      groupGuard.set(guardKey, Date.now());
      await criarGrupoDedicado(inst, emp, assunto, chatid);
      return;
    }
    // funcionária registra um fato/decisão/pendência no diário da empresa (memória compartilhada)
    if (a === 'registrar' || a === 'memoria' || a === 'anotar') {
      registrarEvento(String(action.tipo || 'fato'), action.texto || action.text || action.fato || '',
        { chatid, funcionaria: String(action.funcionaria || action.quem || '') });
      return;
    }
    // recado em OUTRO chat/grupo em nome de uma funcionária (só o DONO pede) — ex.: a Helena
    // cobra a parcela no grupo do cliente sem o Fellipe precisar copiar/colar.
    if (a === 'enviar_grupo' || a === 'mandar_em' || a === 'send_to' || a === 'recado') {
      if (!senderIsOwner) { log('[enviar_grupo] negado: quem pediu não é o dono'); return; }
      const alvoRaw = String(action.grupo || action.para || action.chat || action.alvo || '').trim();
      const texto = String(action.texto || action.text || action.mensagem || action.message || '').trim();
      if (!alvoRaw || !texto) { log('[enviar_grupo] sem alvo/texto'); return; }
      const emp = employeesById.get(String(action.funcionaria || action.employee_id || action.employee || '').toLowerCase());
      let dest = '';
      if (/@(g\.us|s\.whatsapp\.net)$/.test(alvoRaw)) {
        dest = alvoRaw;
      } else if (/^\+?[\d\s()-]+$/.test(alvoRaw) && onlyDigits(alvoRaw).length >= 10) {
        dest = onlyDigits(alvoRaw) + '@s.whatsapp.net';
      } else {
        // busca por NOME entre os chats da instância (grupos e contatos)
        try {
          const { data } = await uaz(inst).post('/chat/find', { sort: '-wa_lastMsgTimestamp', limit: 200 });
          const chats = Array.isArray(data) ? data : (data?.chats || data?.items || data?.data || []);
          const alvo = alvoRaw.toLowerCase();
          const m = (chats || []).find(c => String(c.wa_contactName || c.name || c.wa_name || c.lead_name || '').toLowerCase().includes(alvo));
          if (m) dest = String(m.wa_chatid || m.chatid || m.id || '');
        } catch (e) { log('[enviar_grupo] busca falhou:', e.response?.status || e.message); }
      }
      if (!dest) {
        if (chatid) await sendText(inst, chatid, `Não achei o chat/grupo "${alvoRaw}" aqui 🙈 Confere o nome exato pra mim?`);
        return;
      }
      const cab = emp ? `*${emp.name} · ${emp.role}*\n` : '';
      const ok = await sendText(inst, dest, cab + texto);
      if (chatid) await sendText(inst, chatid, ok
        ? `✅ Recado enviado em *${alvoRaw}*${emp ? ` em nome da ${emp.name}` : ''}.`
        : `Não consegui entregar no "${alvoRaw}" agora 🙈 — vou tentar de novo, e te aviso.`);
      if (ok) registrarEvento('recado', `recado enviado em "${alvoRaw}": ${texto.slice(0, 100)}`,
        { chatid: dest, funcionaria: emp ? emp.name : 'Equipe' });
      log(`[enviar_grupo] ${ok ? 'ok' : 'FALHOU'} -> ${dest} (${emp ? emp.id : 'sem persona'})`);
      return;
    }
    // Bia publica FOTO no Instagram (só quando o pedido veio do DONO — postar é irreversível)
    if (a === 'ig_post' || a === 'ig_publicar' || a === 'instagram_post') {
      if (!temInstagram()) { log('[bia] ig_post sem META_PAGE_TOKEN/META_IG_ID'); return; }
      if (!senderIsOwner) { log('[bia] ig_post negado: quem pediu não é o dono'); return; }
      const img = String(action.image || action.imagem || action.url || action.image_url || '').trim();
      const cap = String(action.caption || action.legenda || action.text || '').trim();
      if (!/^https?:\/\//.test(img)) {
        if (chatid) await sendText(inst, chatid, 'Pra postar no Instagram eu preciso da URL pública da imagem (https://...). Me manda ela que eu publico! 📸');
        return;
      }
      try {
        const r = await igPublicar(img, cap);
        if (chatid) await sendText(inst, chatid, `📸 *Publicado no Instagram!*${r.permalink ? `\n👉 ${r.permalink}` : ''}`);
        registrarEvento('instagram', `Bia publicou no Instagram: ${cap.slice(0, 80) || '(sem legenda)'}${r.permalink ? ' ' + r.permalink : ''}`, { funcionaria: 'Bia' });
        log(`[bia] ig_post ok: ${r.id}`);
      } catch (e) {
        stats.errors++;
        log('[bia] ig_post falhou:', _metaErr(e));
        if (chatid) await sendText(inst, chatid, 'Não consegui publicar agora 🙈 (a Meta recusou). Já avisei o Fellipe do erro — tenta de novo em instantes?');
      }
      return;
    }
    // Bia lê os comentários recentes do Instagram e responde no chat (follow-up com o cérebro)
    if (a === 'ig_comentarios' || a === 'ig_comments') {
      if (!temInstagram() || !chatid) return;
      try {
        const cms = await igComentariosRecentes();
        const followup = cms
          ? `[Comentários recentes do Instagram (id entre colchetes — use em ig_responder):\n${cms}\n\nResuma pro grupo o que merece atenção e sugira respostas. Para responder um, emita <uazapi-action>{"action":"ig_responder","comment_id":"<id>","message":"<resposta>"}</uazapi-action>.]`
          : '[Não há comentários recentes no Instagram. Diga isso com leveza.]';
        const reply = await runAgent(sessionKeyFor(chatid), followup);
        const { parts } = parseAgentReply(reply);
        for (const p of parts) await sendPart(inst, chatid, p);
      } catch (e) { stats.errors++; log('[bia] ig_comentarios falhou:', _metaErr(e)); }
      return;
    }
    // Bia responde um comentário específico do Instagram
    if (a === 'ig_responder' || a === 'ig_reply') {
      if (!temInstagram()) return;
      const cid = String(action.comment_id || action.id || '').trim();
      const msg = String(action.message || action.resposta || action.text || '').trim();
      if (!cid || !msg) { log('[bia] ig_responder sem comment_id/message'); return; }
      try {
        await igResponderComentario(cid, msg.slice(0, 300));
        log(`[bia] ig_responder ok: ${cid}`);
        if (chatid) await sendText(inst, chatid, '💬 Respondido no Instagram!');
      } catch (e) { stats.errors++; log('[bia] ig_responder falhou:', _metaErr(e)); }
      return;
    }
    // troca de funcionária ATIVA no grupo (passa o bastão conforme o assunto) + anúncio visível
    if (a === 'assumir' || a === 'trocar_funcionaria' || a === 'handoff') {
      if (!chatid || !/@g\.us$/.test(String(chatid))) { log('[assumir] só funciona em grupo'); return; }
      const emp = employeesById.get(String(action.funcionaria || action.employee_id || action.employee || action.id || '').toLowerCase());
      if (!emp) { log('[assumir] funcionária inválida:', JSON.stringify(action).slice(0, 120)); return; }
      if (getGroupEmp(chatid) === 'duda') { log('[assumir] grupo da Duda é fixo, troca ignorada'); return; }
      const atualId = getGroupSpeaker(chatid) || getGroupEmp(chatid);
      if (atualId === emp.id) return;
      // anti-ping-pong: 1 troca por grupo a cada 8min (a UX virava bagunça com bastão indo e voltando)
      const cdKey = onlyDigits(chatid) || chatid;
      const lastHandoff = handoffGuard.get(cdKey) || 0;
      if (Date.now() - lastHandoff < HANDOFF_COOLDOWN_MS) { log(`[assumir] em cooldown (${cdKey}), troca ignorada`); return; }
      handoffGuard.set(cdKey, Date.now());
      setGroupSpeaker(chatid, emp.id);
      const atual = atualId ? employeesById.get(atualId) : null;
      const aviso = `🔄 *${emp.name} · ${emp.role}* assumiu daqui. 👋`;
      try { await uaz(inst).post('/send/text', { number: chatid, text: aviso }); }
      catch (e) { stats.errors++; log('[assumir] aviso falhou:', e.message); }
      registrarEvento('handoff', `${emp.name} assumiu a conversa no grupo${atual ? ` (era a ${atual.name})` : ''}`, { chatid, funcionaria: emp.name });
      log(`[assumir] ${chatid}: ${atualId || '—'} -> ${emp.id}`);
      return;
    }
    // Duda pediu pra LER uma conversa do WhatsApp pessoal do dono -> busca e responde em follow-up
    if (a === 'ler_conversa' || a === 'read_chat' || a === 'ler_zap') {
      const quem = String(action.quem || action.who || action.contato || action.nome || action.numero || '').trim();
      if (!quem || !chatid) { log('[ler_conversa] sem alvo/chatid'); return; }
      const conteudo = await lerConversaPessoal(quem);
      const followup = conteudo
        ? `[Você pediu pra ler a conversa de "${quem}" no WhatsApp PESSOAL do Fellipe. Aqui está (mais novas embaixo):\n${conteudo}\n\nAgora responda no grupo com o resumo/insight útil pro Fellipe (curto, direto, sem recitar tudo). Se fizer sentido, sugira uma resposta pronta que ele possa copiar.]`
        : `[Não encontrei conversa com "${quem}" no WhatsApp pessoal do Fellipe. Diga isso a ele com leveza e pergunte se o nome/número está certo.]`;
      try {
        const reply = await runAgent(sessionKeyFor(chatid), followup);
        const { parts } = parseAgentReply(reply);
        for (const p of parts) await sendPart(inst, chatid, p);
        log(`[ler_conversa] "${quem}" -> ${parts.length} parte(s) em ${chatid}`);
      } catch (e) { stats.errors++; log('[ler_conversa] follow-up falhou:', e.message); }
      return;
    }
    // tornar alguém ADMIN do grupo (a funcionária é admin nos grupos que ELA criou)
    if (a === 'promote_admin' || a === 'make_admin' || a === 'tornar_admin' || a === 'admin') {
      if (!chatid || !/@g\.us$/.test(String(chatid))) { log('[promote_admin] precisa ser num grupo'); return; }
      const brutos = action.numbers || action.participants || [action.number || action.numero || action.who];
      const alvos = [].concat(brutos).map(onlyDigits).filter(Boolean);
      const lista = alvos.length ? alvos : OWNER.map(onlyDigits).filter(Boolean); // sem alvo -> promove o dono
      try {
        await uaz(inst).post('/group/updateParticipants', { groupjid: chatid, action: 'promote', participants: lista });
        log(`[promote_admin] ${chatid} -> ${lista.join(',')}`);
      } catch (e) { log('[promote_admin] falhou: ' + (e.response?.status || e.message)); }
      return;
    }
    log(`[${inst.id}] action:`, a || JSON.stringify(action).slice(0, 80));
  } catch (e) { log('[runAction] erro: ' + e.message); }
}

// ---------- @conectar: integrações via Composio ----------
const COMPOSIO_API = process.env.COMPOSIO_API || 'https://backend.composio.dev/api/v3';
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || '';
const COMPOSIO_USER = process.env.COMPOSIO_USER_ID || 'saraiva';
const CONECTAR_APPS = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Agenda' },
  { slug: 'googlesheets', name: 'Google Sheets' },
  { slug: 'googledrive', name: 'Google Drive' },
];
function composioApi() {
  return axios.create({ baseURL: COMPOSIO_API, headers: { 'x-api-key': COMPOSIO_KEY, 'Content-Type': 'application/json' }, timeout: 25000 });
}
async function composioAuthConfigId(slug) {
  try {
    const { data } = await composioApi().get(`/auth_configs?toolkit_slug=${slug}`);
    const items = data.items || data || [];
    const found = (Array.isArray(items) ? items : []).find(i => !i.is_disabled);
    if (found && found.id) return found.id;
  } catch (e) {}
  const { data } = await composioApi().post('/auth_configs', { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' } });
  return (data.auth_config && data.auth_config.id) || data.id;
}
async function composioConnect(slug, userId) {
  if (!COMPOSIO_KEY) throw new Error('COMPOSIO_API_KEY ausente');
  const acId = await composioAuthConfigId(slug);
  const { data } = await composioApi().post('/connected_accounts', { auth_config: { id: acId }, connection: { user_id: userId || COMPOSIO_USER } });
  return data.redirect_url || data.redirect_uri || (data.connectionData && data.connectionData.redirectUrl) || null;
}
function conectarCarousel(chatid = null) {
  const cards = CONECTAR_APPS.map(a => ({
    category: a.name,
    image: `app-${a.slug}.jpg`,
    text: `*${a.name}*\n━━━━━━━━━━━━\nToque em *Conectar* que eu passo a enxergar seu ${a.name} e te ajudo de verdade.`,
    buttons: [[`connect_${a.slug}`, `Conectar ${a.name}`]],
  }));
  return carousel('Liga suas ferramentas que eu passo a ver tudo e trabalhar junto com você. Toque em *Conectar* no que quiser.', cards, chatid);
}

// ---------- DEMO interativa (estática, sem cérebro): "como seria pra minha clínica" ----------
const DEMO_PROCS = [
  { slug: 'limpeza',          nome: 'Limpeza de Pele Profunda', dur: '50 min', preco: '120', benef: 'Tira cravo, controla oleosidade e ilumina. Pele renovada na hora.' },
  { slug: 'botox',            nome: 'Botox · Toxina',           dur: '30 min', preco: '690', benef: 'Suaviza linhas de expressão com naturalidade — dura uns 4 meses.' },
  { slug: 'preenchimento',    nome: 'Preenchimento Labial',     dur: '40 min', preco: '890', benef: 'Volume e contorno nos lábios, com harmonia no rosto.' },
  { slug: 'microagulhamento', nome: 'Microagulhamento',         dur: '60 min', preco: '350', benef: 'Estimula colágeno: ataca marcas, poros e devolve viço.' },
  { slug: 'massagem',         nome: 'Massagem Modeladora',      dur: '60 min', preco: '150', benef: 'Modela, drena e relaxa. Você sai leve e renovada.' },
];
const DEMO_PROC = Object.fromEntries(DEMO_PROCS.map(p => [p.slug, p]));
const DEMO_HORAS = { amanha14: 'amanhã às 14h', qui10: 'quinta às 10h', sab9: 'sábado às 9h' };

function demoMenu() {
  return { type: 'button', text: '✨ *Quer ver a Empresa.ia em ação?*\nEscolhe um exemplo de atendimento real 👇',
    choices: ['💆 Clínica de estética|demo_estetica', '🛍️ Loja / Vendas|demo_loja', '💬 Atendimento|demo_atend'] };
}
function demoEsteticaCarousel(chatid) {
  const cards = DEMO_PROCS.map(p => ({
    category: 'estetica',
    image: `proc-${p.slug}.jpg`,
    fallbackImage: carouselAssets.criativo || 'apps-criativo.jpg',
    text: `*${p.nome}*\n━━━━━━━━━━━━\n${p.benef}\n\n⏱ ${p.dur} · a partir de R$ ${p.preco}`,
    buttons: [[`demo_agendar_${p.slug}`, 'Agendar avaliação'], [`demo_preco_${p.slug}`, 'Ver valores']],
  }));
  return carousel('💆 *Cardápio da clínica.* Toque em *Agendar avaliação* no que te interessa 👇', cards, chatid);
}
function demoAgendarMenu(slug) {
  const p = DEMO_PROC[slug] || DEMO_PROCS[0];
  return { type: 'button', text: `📅 Boa escolha — *${p.nome}*!\nQue dia fica melhor pra sua avaliação?`, choices: [
    `Amanhã 14h|demo_hora_${p.slug}_amanha14`,
    `Quinta 10h|demo_hora_${p.slug}_qui10`,
    `Sábado 9h|demo_hora_${p.slug}_sab9`,
  ] };
}
function demoConfirmacaoTxt(slug, hora) {
  const p = DEMO_PROC[slug] || DEMO_PROCS[0];
  const h = DEMO_HORAS[hora] || 'no horário escolhido';
  return `✅ *Agendado!* ${p.nome} — *${h}*. Te lembro no dia, pode deixar 🙌\n\n> *Nos bastidores* eu já puxaria isso pra sua agenda, avisaria a recepção, e se a pessoa sumisse eu recuperaria — sem você levantar um dedo.`;
}
function demoFechamentoMenu() {
  return { type: 'button', text: 'É *assim* que sua clínica para de perder cliente: respondo na hora, agendo, lembro e recupero quem sumiu. 💚', choices: [
    'Quero pra minha clínica|demo_quero',
    'Ver de novo|demo_estetica',
  ] };
}
function demoCTAtxt() {
  return `Aê! 🎉 Bora montar a sua então.\n\nA Empresa.ia entra no *seu* WhatsApp como um time inteiro — atendimento, vendas, agenda e recuperação — trabalhando 24h. No seu, eu uso *seus* procedimentos, *seus* preços e *sua* agenda de verdade.\n\n👉 https://empresa.ia.br`;
}
const DEMO_SCENE = 'Bora! 💆\n\nImagina que você tem uma clínica de estética e um cliente acabou de chamar no WhatsApp. Olha como a *Maya*, do atendimento, receberia — com o cardápio na mão e agendamento na hora 👇';
const DEMO_EM_BREVE = 'Esse exemplo tá saindo do forno 🔥 Por enquanto experimenta o de *clínica de estética* (é o mais completo) — manda *demo* e toca em 💆. Em breve solto Loja/Vendas e Atendimento.';
function demoRoute(cmd, chatid) {
  let m;
  if (cmd === 'demo' || cmd === '@demo' || cmd === 'demo_menu') return [demoMenu()];
  if (cmd === 'demo_estetica') return [DEMO_SCENE, demoEsteticaCarousel(chatid)];
  if (cmd === 'demo_loja' || cmd === 'demo_atend') return [DEMO_EM_BREVE, demoMenu()];
  if ((m = cmd.match(/^demo_agendar_([a-z]+)$/))) return [demoAgendarMenu(m[1])];
  if ((m = cmd.match(/^demo_preco_([a-z]+)$/))) { const p = DEMO_PROC[m[1]] || DEMO_PROCS[0]; return [`💰 *${p.nome}* — a partir de *R$ ${p.preco}* (${p.dur}). O valor exato a gente fecha na avaliação, conforme o seu caso.\n\nQuer que eu já reserve um horário? 👇`, demoAgendarMenu(m[1])]; }
  if ((m = cmd.match(/^demo_hora_([a-z]+)_([a-z0-9]+)$/))) return [demoConfirmacaoTxt(m[1], m[2]), demoFechamentoMenu()];
  if (cmd === 'demo_quero') return [demoCTAtxt()];
  return [demoMenu()];
}
function isDemoTrigger(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^demo_[a-z0-9_]+$/.test(t)) return t;
  if (/^(@?demo|exemplo|ver (um )?exemplo|quero testar|quero ver (a )?demo|me mostra (um )?exemplo)$/.test(t)) return 'demo';
  return null;
}

// histórico recente do grupo p/ dar contexto ao agente (a menção isolada não basta)
async function fetchGroupHistory(inst, chatid, limit = 12) {
  try {
    const { data } = await uaz(inst).post('/message/find', { chatid, limit });
    const msgs = Array.isArray(data) ? data : (data.messages || data.data || []);
    const lines = [];
    for (const m of msgs) {
      if (isFromMe(m)) continue; // não repete as próprias respostas
      const nm = senderName(m) || 'alguém';
      const tx = cleanMentions(extractText(m), inst).replace(/\s+/g, ' ').trim();
      if (tx) lines.push(`${nm}: ${tx.slice(0, 240)}`);
    }
    return lines.slice(-limit);
  } catch (e) {
    log(`[${inst.id}] message/find erro:`, e.response?.status || e.message);
    return [];
  }
}

// ---------- cérebro: openclaw agent ----------
function runAgent(sessionKey, message) {
  return new Promise((resolve, reject) => {
    // --thinking off: resposta direta e RÁPIDA (~5s) em vez de ficar "raciocinando" (15-20s).
    const args = ['agent', '--agent', 'main', '--thinking', process.env.AGENT_THINKING || 'off', '--session-key', sessionKey, '-m', message, '--json'];
    const c = spawn(OPENCLAW_BIN, args, { env: process.env });
    let so = '', se = '';
    const killer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, (AGENT_TIMEOUT + 15) * 1000);
    c.stdout.on('data', d => so += d);
    c.stderr.on('data', d => se += d);
    c.on('error', (e) => { clearTimeout(killer); reject(e); });
    c.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`openclaw exit ${code}: ${(se || so).slice(-400)}`));
      try {
        const j = JSON.parse(so);
        const result = j.result || j;
        const meta = result.meta || {};
        const fromPayloads = (result.payloads || []).map(p => p.text).filter(Boolean).join('\n\n');
        resolve(fromPayloads || meta.finalAssistantVisibleText || meta.finalAssistantRawText || '');
      } catch (e) { reject(new Error(`bad JSON: ${so.slice(0, 300)}`)); }
    });
  });
}

// ---------- dispatch ----------
const pending = new Map(); // chatid -> {timer, texts[], data}
const chains = new Map();  // chatid -> Promise (serializa turnos da MESMA conversa)
function sessionKeyFor(chatid) { return `agent:main:wa:${onlyDigits(chatid) || chatid}`; }

// 1 turno por vez por conversa (evita 2 openclaw na mesma sessão = deadlock do claude CLI)
// watchdog: se um turno passar de AGENT_TIMEOUT+30s, libera a corrente p/ não travar a conversa.
function enqueue(chatid, fn, onTimeout) {
  const prev = chains.get(chatid) || Promise.resolve();
  const guarded = () => Promise.race([
    Promise.resolve().then(fn),
    sleep((AGENT_TIMEOUT + 30) * 1000).then(() => { const err = new Error('watchdog: turno excedeu limite'); err.isWatchdog = true; throw err; }),
  ]);
  const next = prev.then(guarded, guarded).catch(async (e) => {
    stats.errors++;
    log('[chain] erro:', e.message);
    // CONTENÇÃO: se o turno travou além do watchdog (cérebro pendurado), avisa a pessoa — nunca silêncio.
    if (e && e.isWatchdog && typeof onTimeout === 'function') { try { await onTimeout(); } catch {} }
  });
  const tracked = next.finally(() => { if (chains.get(chatid) === tracked) chains.delete(chatid); });
  chains.set(chatid, tracked);
  return tracked;
}

// ---------- INTELIGÊNCIA DE CONTEXTO: com QUEM você fala + O QUE você realmente pode fazer ----------
// capacidades reais hoje (vs o que ainda não tem) — pra a funcionária PARAR de prometer o que não faz.
const CAPACIDADES_REMINDER = `[SUAS CAPACIDADES REAIS AGORA — seja honesta, NUNCA prometa o que não está ligado:
✓ VOCÊ PODE: conversar e orientar; apresentar a equipe e a demo ao vivo; captar/qualificar lead; transcrever áudio, descrever imagem e reconhecer arquivo recebido; PUBLICAR página/landing na web de verdade (comando publicar-site → devolve URL em sites.empresa.ia.br); MANDAR RECADO em outro grupo/conversa em nome de uma funcionária quando o FELLIPE pedir — emita <uazapi-action>{"action":"enviar_grupo","grupo":"<nome do grupo ou número>","texto":"<mensagem>","funcionaria":"<id>"}</uazapi-action> (ex.: Helena cobrando parcela no grupo do cliente) e CONFIRME só depois do ✅; com @conectar, usar Gmail/Agenda/Sheets/Drive (Composio)${'${IG_CAP}'}.
✗ VOCÊ AINDA NÃO TEM: ${'${IG_NO}'}gerar PIX/link de cobrança automática (mandar MENSAGEM de cobrança você PODE, via enviar_grupo); assinar ou enviar contrato (ZapSign não está ligado); marcar de verdade na agenda.
Se perguntarem "como funciona": explique a EXPERIÊNCIA (equipe de especialistas no WhatsApp que também atende ligação, grupos por assunto, debate @roda) e sugira mandar @ajuda pro guia completo. Se pedirem algo do ✗: fale a verdade — diga que ainda não está ligado e que você já aciona o Fellipe pra resolver. JAMAIS diga "já postei / já enviei / já assinei / já agendei" se não fez de fato.]`;
function capacidadesReminder() {
  const ig = temInstagram();
  return CAPACIDADES_REMINDER
    .replace('${IG_CAP}', ig
      ? '; POSTAR NO INSTAGRAM de verdade (a Bia publica foto com legenda — action ig_post com a URL pública da imagem; SÓ quando o Fellipe pedir/aprovar), ler e responder comentários do Instagram (actions ig_comentarios / ig_responder)'
      : '')
    .replace('${IG_NO}', ig ? '' : 'postar em redes sociais; ');
}
// ficha de QUEM você está atendendo (nome, relação, negócio, histórico) a partir do que já sabemos dele.
function fichaContexto(chatid, data, grupo) {
  const perfil = empresaiaUsageProfile(chatid);
  const lead = (loadLeads() || {})[onlyDigits(chatid)] || {};
  const nome = perfil.nome || lead.nome || senderName(data) || '';
  const negocio = perfil.negocio || lead.ramo || lead.empresa || '';
  const total = perfil.total || 0;
  const topCats = Object.entries(perfil.categories || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  let relacao;
  if (isOwnerChatid(chatid)) relacao = 'é o FELLIPE, o DONO da Empresa.ia (seu chefe) — seja direta e executora, NÃO venda pra ele';
  else if (grupo && getGroupEmp(chatid)) relacao = 'grupo dedicado da Empresa.ia (pode ter clientes e o Fellipe juntos)';
  else if (lead.status === 'cliente') relacao = 'é CLIENTE da casa';
  else if (negocio || total > 2 || lead.status) relacao = 'lead/contato já conhecido';
  else relacao = 'contato NOVO — você ainda sabe pouco, então acolha e descubra';
  const bits = [];
  if (nome) bits.push(`Nome: ${nome}`);
  bits.push(relacao);
  if (negocio) bits.push(`negócio: ${negocio}`);
  if (total) bits.push(`já falou ${total}x${topCats.length ? ` (interesses: ${topCats.join('/')})` : ''}`);
  if (lead.dor) bits.push(`dor citada: ${lead.dor}`);
  if (lead.temperatura) bits.push(`temperatura: ${lead.temperatura}`);
  return `[QUEM VOCÊ ESTÁ ATENDENDO: ${bits.join(' · ')}. Chame a pessoa pelo nome, lembre do que já sabe e NÃO pergunte de novo o que já está aqui.]`;
}
async function handle(inst, chatid, data, text) {
  const grupo = isGroup(data);
  const nome = senderName(data) || '';
  const trimmedText = String(text || '').trim();
  const callMatch = trimmedText.toLowerCase().match(/^call_employee_([a-z0-9_-]+)$/);
  if (callMatch) {
    const employee = employeesById.get(callMatch[1]);
    if (!employee) {
      await sendText(inst, chatid, 'Nao encontrei esse funcionario da Empresa.ia. Me manda @funcionarios para abrir a equipe.');
      stats.answered++; stats.lastAnswerAt = new Date().toISOString();
      return;
    }
    recordEmpresaiaUsage(chatid, trimmedText);
    try {
      const result = await makeEmployeeCall(employee, chatid, data, trimmedText);
      stats.callsStarted++; stats.lastCallAt = new Date().toISOString();
      await sendText(inst, chatid, `📞 ${employee.name} esta te ligando pelo WhatsApp agora.\n\nSetor: ${employee.role}\nMotivo: ${employee.mission}.\n\nSe nao tocar, eu te aviso aqui e tentamos de novo.`);
      log(`[${inst.id}] wavoip/${employee.id} -> ${chatid}: ${JSON.stringify(result || {}).slice(0, 160)}`);
    } catch (e) {
      stats.callsFailed++;
      stats.errors++;
      await sendText(inst, chatid, `Tentei pedir para ${employee.name} te ligar pelo WhatsApp, mas a chamada nao iniciou agora.\n\nVou manter o diagnostico por aqui e deixo a opcao de chamada pronta para tentar de novo em instantes.`);
      log(`[${inst.id}] wavoip/${employee.id} erro:`, e.response?.status || '', JSON.stringify(e.response?.data || e.message).slice(0, 240));
    }
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // "Falar com a <Nome>" — a especialista entra com áudio de apresentação (voz) + detalhe
  const talkMatch = trimmedText.toLowerCase().match(/^talk_([a-z0-9_-]+)$/);
  if (talkMatch) {
    const employee = employeesById.get(talkMatch[1]);
    if (!employee) {
      await sendText(inst, chatid, 'Não achei essa pessoa da equipe. Manda @equipe que eu te mostro quem cuida de cada área.');
      stats.answered++; stats.lastAnswerAt = new Date().toISOString();
      return;
    }
    recordEmpresaiaUsage(chatid, trimmedText);
    const target = grupo ? (extractSenderChatid(data) || chatid) : chatid;
    if (grupo && target !== chatid) await sendText(inst, chatid, `Te chamei no privado com a ${employee.name}. 😉`);
    await sendPart(inst, target, { type: 'ptt', url: assetUrl(employee.audio), delay: 600 });
    await sendPart(inst, target, employeeDetailCarousel(employee.id, target));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] talk/${employee.id} -> ${target}`);
    return;
  }
  // clique em "Conectar <app>" -> gera o link OAuth do Composio e manda
  const connectMatch = trimmedText.toLowerCase().match(/^connect_([a-z0-9_-]+)$/);
  if (connectMatch) {
    const slug = connectMatch[1];
    const app = CONECTAR_APPS.find(a => a.slug === slug);
    recordEmpresaiaUsage(chatid, trimmedText);
    try {
      const url = await composioConnect(slug, onlyDigits(chatid));
      if (url) {
        await sendText(inst, chatid, `Boa! Pra ligar o *${app ? app.name : slug}*, é só autorizar nesse link rapidinho:\n\n${url}\n\n> 💡 Depois que autorizar, me avisa que eu já começo a usar.`);
      } else {
        await sendText(inst, chatid, 'Tentei gerar o link de conexão, mas não veio agora. Já tento de novo, tá?');
      }
    } catch (e) {
      stats.errors++;
      await sendText(inst, chatid, 'Deu um probleminha pra gerar o link agora. Tenta de novo em instantes.');
      log(`[${inst.id}] connect/${slug} erro: ${e.message}`);
    }
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  const empresaiaReply = empresaiaResponseFor(trimmedText, isOwnerChatid(chatid), chatid);
  if (empresaiaReply) {
    recordEmpresaiaUsage(chatid, trimmedText);
    if (grupo && isInteractivePart(empresaiaReply)) await sendGroupInteractivePrivately(inst, chatid, data, empresaiaReply);
    else await sendPart(inst, chatid, empresaiaReply);
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] empresaia dynamic ${trimmedText} -> ${chatid}`);
    return;
  }
  // Tier 0: ONBOARDING conversacional de quem NÃO é dono (lead) em DM:
  // conexão (pergunta o NOME) -> pergunta o NICHO -> ÁUDIO personalizado (voz, cita nome+negócio,
  // mostra benefícios pro negócio dela) -> revela equipe + demo. "venda sem vender, encanta".
  if (!grupo && !isOwnerChatid(chatid) && !isDemoTrigger(trimmedText)) {
    const perfil = empresaiaUsageProfile(chatid);
    const etapa = perfil.onboard;
    if (!etapa) {
      perfil.onboard = 'ask_name';
      scheduleEmpresaiaUsageSave();
      await sendText(inst, chatid, onboardPerguntaNome(), extractMsgId(data));
      stats.answered++; stats.lastAnswerAt = new Date().toISOString();
      log(`[${inst.id}] onboard ask_name -> ${chatid}`);
      return;
    }
    if (etapa === 'ask_name') {
      const nomeLead = extrairNome(trimmedText);
      perfil.nome = nomeLead;
      perfil.onboard = 'ask_niche';
      scheduleEmpresaiaUsageSave();
      await sendText(inst, chatid, onboardPerguntaNicho(nomeLead));
      stats.answered++; stats.lastAnswerAt = new Date().toISOString();
      log(`[${inst.id}] onboard ask_niche (${nomeLead || '?'}) -> ${chatid}`);
      return;
    }
    if (etapa === 'ask_niche') {
      perfil.negocio = String(trimmedText).slice(0, 80);
      perfil.onboard = 'done';
      scheduleEmpresaiaUsageSave();
      try { upsertLead(chatid, { nome: perfil.nome, ramo: perfil.negocio, status: 'novo', temperatura: 'morno' }); } catch {}
      await onboardEntregaAudio(inst, chatid, perfil.nome, perfil.negocio);
      stats.answered++; stats.lastAnswerAt = new Date().toISOString();
      log(`[${inst.id}] onboard audio (${perfil.nome || '?'} / ${perfil.negocio}) -> ${chatid}`);
      return;
    }
    // etapa 'done': segue o fluxo normal (Sofia conversa pelo cérebro)
  }
  // @duda / @meuzap (só o DONO, em DM): cria o grupo dedicado da Duda pra gerenciar o zap pessoal
  if (!grupo && isOwnerChatid(chatid) && /^@(duda|meuzap|meu\s*zap)\b/i.test(trimmedText)) {
    const duda = employeesById.get('duda');
    if (!temZapPessoal()) {
      await sendText(inst, chatid, 'A Duda ainda não está ligada no seu WhatsApp pessoal (faltam PERSONAL_UAZ_SERVER/PERSONAL_UAZ_TOKEN no servidor). Me avisa que eu configuro!', extractMsgId(data));
      return;
    }
    const r = await criarGrupoDedicado(inst, duda, 'Seu WhatsApp', chatid);
    if (!r) await sendText(inst, chatid, 'Não consegui criar o grupo agora 🙈 tenta de novo em instantes?', extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // @ajuda / "como funciona": manual da casa — instantâneo, sem cérebro
  if (!grupo && /^(@ajuda|@comandos|@manual|como funciona\??)$/i.test(trimmedText)) {
    const dono = isOwnerChatid(chatid);
    const manualCliente = [
      '*Como funciona a Empresa.ia* 🧭',
      '',
      'Você fala comigo como falaria com uma equipe de verdade — em texto ou áudio. Por trás, tem uma especialista pra cada área:',
      '',
      '👥 *@equipe* — conheça as 7 (foto e voz de cada uma)',
      '🗣️ *"Falar com a Clara"* — chama a especialista pelo nome (vendas, financeiro, redes...)',
      '🎬 *demo* — veja um exemplo ao vivo',
      '📞 As funcionárias também *atendem e fazem ligação* de telefone — e a conversa continua daqui',
      '🧠 *@roda <pergunta>* — as especialistas debatem sua questão e devolvem uma recomendação',
      '',
      'Pode pedir com suas palavras: "quero organizar meu atendimento", "me ajuda com vendas"... a Sofia te direciona. 😉',
    ].join('\n');
    const manualDono = [
      '*Manual da casa (visão do dono)* 🧭',
      '',
      '*Conversa & equipe*',
      '👥 *@equipe* — vitrine das funcionárias · _"Falar com a X"_ chama uma específica',
      '🧠 *@roda <pergunta>* — Roda das Mentes: debate em 3 rodadas + síntese da Sofia',
      '🔄 Nos grupos, elas passam o bastão por assunto (anúncio curto, sem ping-pong)',
      '',
      '*Seu WhatsApp pessoal (Duda)*',
      '💬 *@duda* — cria o grupo dela · lá ela vê seus chats, lê conversas e rascunha respostas',
      '🌅 *@digest* — resumo do seu zap agora (automático todo dia às 8h)',
      '',
      '*Painéis e memória*',
      '📊 *@relatorios* — cria os grupos 📊 Interações (quem fala com quem) e 📞 Ligações',
      '📔 Diário da empresa: tudo que acontece (ligações, posts, recados, decisões) vira memória compartilhada — pergunte "o que aconteceu hoje?" a qualquer funcionária',
      '',
      '*Ações reais*',
      '📸 Bia posta no Instagram (mande a imagem + legenda) e responde comentários',
      '📨 Recado em outro grupo em seu nome: "manda lá no grupo X com a Helena: ..."',
      '📞 Ligação muda → ela avisa no zap e *liga de volta sozinha*',
      '🛡️ Sentinela: se algum serviço cair, você é avisado aqui em até 5min',
    ].join('\n');
    await sendText(inst, chatid, dono ? manualDono : manualCliente, extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] @ajuda (${dono ? 'dono' : 'cliente'}) -> ${chatid}`);
    return;
  }
  // @metricas (dono): relatório de desempenho do Instagram agora (análise da Bia)
  if (!grupo && isOwnerChatid(chatid) && /^@m[ée]tricas?\b/i.test(trimmedText)) {
    await setPresence(inst, chatid, 'composing');
    const ok = await enviarRelatorioMetricas(inst, 'manual');
    if (!ok) await sendText(inst, chatid, 'Não consegui puxar as métricas agora (Instagram fora?). Olha os logs.', extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // @agenda (dono): mostra os próximos Reels agendados e o status da fila
  if (!grupo && isOwnerChatid(chatid) && /^@agenda\b/i.test(trimmedText)) {
    const fila = loadSchedule();
    const pend = fila.filter(p => p.status === 'pendente');
    const pub = fila.filter(p => p.status === 'publicado').length;
    const err = fila.filter(p => p.status === 'erro').length;
    const prox = pend.slice(0, 6).map(p => `• ${p.quandoSP || new Date(p.quando).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — ${String(p.caption || '').split('\n')[0].slice(0, 50)}`).join('\n');
    await sendText(inst, chatid, `📅 *Agenda de Reels*\n\n✅ publicados: ${pub} · ⏳ na fila: ${pend.length}${err ? ` · ⚠️ erros: ${err}` : ''}\n\n*Próximos:*\n${prox || '(fila vazia)'}`, extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // @relatorios (dono): cria os painéis 📊 Interações e 📞 Ligações
  if (!grupo && isOwnerChatid(chatid) && /^@relat[óo]rios?\b/i.test(trimmedText)) {
    const g = await criarGruposRelatorio(inst);
    const ok = g.interacoes && g.ligacoes;
    await sendText(inst, chatid, ok
      ? '✅ Painéis criados! *📊 Interações* (quem fala com qual funcionária) e *📞 Ligações* (quem ligou, quem atendeu, assunto). Tudo chega lá em tempo real.'
      : 'Criei o que deu 🙈 — algum painel falhou, tenta @relatorios de novo em instantes.', extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // @digest (dono): dispara o digest matinal da Duda agora (teste/sob demanda)
  if (isOwnerChatid(extractSenderChatid(data) || chatid) && /^@digest\b/i.test(trimmedText)) {
    const ok = await enviarDigestDuda('manual');
    if (!ok) await sendText(inst, chatid, 'Não consegui montar o digest agora (instância do seu zap fora do ar?). Olha os logs que eu conto o porquê.', extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    return;
  }
  // @roda <pergunta>: Roda das Mentes — as especialistas DEBATEM a questão entre si (3 rodadas)
  const rodaMatch = trimmedText.match(/^@?roda(?:\s+d[ae]s?\s+mentes)?\s*[:,–-]?\s*(.*)$/i);
  if (rodaMatch && (trimmedText.toLowerCase().startsWith('@roda') || /^roda\s+d[ae]s?\s+mentes/i.test(trimmedText))) {
    const pergunta = (rodaMatch[1] || '').trim();
    if (!pergunta) {
      await sendText(inst, chatid, '🧠 *Roda das Mentes* — me manda assim: `@roda <sua pergunta>` que eu coloco as especialistas pra debater.', extractMsgId(data));
      return;
    }
    await setPresence(inst, chatid, 'composing');
    await rodaDasMentes(inst, chatid, pergunta, extractMsgId(data));
    return;
  }
  // Tier 0: saudação simples em DM (dono ou retorno) -> resposta instantânea, calorosa, sem cérebro e sem loading
  if (!grupo && isSaudacao(trimmedText)) {
    await sendText(inst, chatid, saudacaoInstantanea(nome), extractMsgId(data));
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] saudação instantânea -> ${chatid}`);
    return;
  }
  // DEMO interativa (estática, instantânea, à prova de falha) — em DM. "demo" / "exemplo" / cliques demo_*
  const demoCmd = !grupo ? isDemoTrigger(trimmedText) : null;
  if (demoCmd) {
    recordEmpresaiaUsage(chatid, trimmedText);
    const rid = extractMsgId(data);
    const parts = demoRoute(demoCmd, chatid);
    for (let i = 0; i < parts.length; i++) await sendPart(inst, chatid, parts[i], i === 0 ? rid : null);
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] demo ${demoCmd} -> ${chatid}`);
    return;
  }
  let header;
  const ficha = fichaContexto(chatid, data, grupo);
  if (grupo) {
    const hist = await fetchGroupHistory(inst, chatid, 12);
    const ctx = hist.length ? `Conversa recente no grupo:\n${hist.join('\n')}\n\n` : '';
    const gOwnerId = getGroupEmp(chatid);
    const gSpkId = getGroupSpeaker(chatid);
    // quem FALA agora: porta-voz ativa (se trocou) > dona do grupo
    const gEmp = (gSpkId && employeesById.get(gSpkId)) || (gOwnerId && employeesById.get(gOwnerId)) || null;
    // grupo da Duda = dados do WhatsApp PESSOAL do dono: só o DONO conversa com ela ali
    if (gOwnerId === 'duda' && !OWNER.includes(onlyDigits(extractSenderChatid(data) || ''))) {
      log(`[duda] mensagem de não-dono ignorada no grupo ${chatid}`);
      return;
    }
    let zapPessoal = '';
    if (gOwnerId === 'duda') {
      const snap = await snapshotZapPessoal();
      zapPessoal = snap
        ? `\n[VISÃO AO VIVO DO WHATSAPP PESSOAL DO FELLIPE (você enxerga isso DE VERDADE, agora — não é simulação):\n${snap}\nSeu papel: ajudar o Fellipe a GERENCIAR esse WhatsApp — quem espera resposta, o que é prioridade, resumos, rascunhos de resposta. Pra LER uma conversa específica na íntegra, emita <uazapi-action>{"action":"ler_conversa","quem":"<nome ou número>"}</uazapi-action> (e avise que vai olhar). NUNCA invente conteúdo de conversa que não está aqui.]`
        : '\n[ATENÇÃO: não consegui puxar a visão do WhatsApp pessoal agora (instância fora?). Seja honesta com o Fellipe sobre isso.]';
    }
    // Bia ativa no grupo: enxerga o Instagram de verdade (perfil + últimos posts)
    if (gEmp && gEmp.id === 'bia' && temInstagram()) {
      const snapIg = await snapshotInstagram();
      if (snapIg) {
        zapPessoal += `\n[VISÃO AO VIVO DO INSTAGRAM (você enxerga isso DE VERDADE):\n${snapIg}\n`
          + 'Você PODE: postar foto (action ig_post {"image":"<url pública>","caption":"..."} — SÓ com pedido/aprovação do Fellipe), '
          + 'ler comentários (action ig_comentarios) e responder comentário (action ig_responder {"comment_id":"...","message":"..."}). '
          + 'NUNCA diga que postou sem a confirmação aparecer no grupo.]';
      }
    }
    const personaHint = gEmp ? `Neste grupo VOCÊ é a ${gEmp.name}, da área de ${gEmp.role} — responda como ela, no jeito dela. ` : '';
    // bastão: troca SÓ quando o assunto MUDA de verdade e vai continuar com a outra. Sem ping-pong.
    const handoffHint = gEmp ? ('BASTÃO (use com parcimônia): só emita <uazapi-action>{"action":"assumir","funcionaria":"<id>"}</uazapi-action> '
      + 'quando a conversa VAI CONTINUAR com outra especialista por várias mensagens (o assunto mudou de área de verdade ou a pessoa pediu). '
      + 'Pra uma dúvida PONTUAL de outra área, a colega responde no seu turno SEM assumir nada. '
      + 'PROIBIDO: trocar de funcionária duas vezes em poucos minutos (ping-pong), ou assumir só pra dizer uma frase. '
      + 'Ids: sofia(gerência), clara(vendas), helena(financeiro), bia(redes sociais), maya(atendimento), '
      + 'lara(operação), nina(rotina/agenda), alice(onboarding), dani(desenvolvimento). ') : '';
    const nomeBold = gEmp ? `${gEmp.name} · ${gEmp.role}` : 'seu nome · seu setor';
    const boldHint = `IMPORTANTE: comece sua resposta com *${nomeBold}* em NEGRITO na primeira linha (nome E setor, exatamente assim) e a mensagem na linha de baixo. Faça isso só na primeira mensagem do seu turno. `
      + 'REGRA DE OURO DO GRUPO: responda CURTO — uma funcionária por vez, 2-4 linhas, direto ao ponto. NADA de parede de texto. '
      + 'NUNCA coloque mais de uma funcionária na MESMA mensagem: se outra colega for falar, a fala dela é um PARÁGRAFO NOVO '
      + '(linha em branco antes) começando com o *Nome · Setor* dela — isso vira uma mensagem separada no WhatsApp. '
      + 'Com CLIENTE na conversa: no MÁXIMO 2 falas por turno (você + no máximo UMA colega, e só quando agrega de verdade) — '
      + 'JAMAIS faça a equipe inteira se manifestar em sequência; cliente não quer reunião, quer resposta. '
      + 'Papo maior de equipe (3-4 falas) só quando o FELLIPE pedir a opinião do time ou na Roda das Mentes. ';
    // diário da empresa: dono vê TUDO; cliente em grupo dedicado vê só o que é do chat dele
    const senderEhDono = OWNER.includes(onlyDigits(extractSenderChatid(data) || ''));
    const diario = gEmp ? diarioEmpresa({ paraDono: senderEhDono, chatid, limite: senderEhDono ? 12 : 5 }) : '';
    header = `[${ctx}${personaHint}${handoffHint}${boldHint}${nome || 'Alguém'} falou com você no grupo. Responda no grupo, direto e curto, no contexto acima.]${zapPessoal}${diario}\n${ficha}`;
  } else {
    const diario = isOwnerChatid(chatid)
      ? diarioEmpresa({ paraDono: true, limite: 12 })
      : diarioEmpresa({ paraDono: false, chatid, limite: 5 });
    header = `${ficha}${diario}`;
  }
  const message = `${capacidadesReminder()}\n${header ? header + '\n' : ''}${text}`;
  const sk = sessionKeyFor(chatid);
  const replyId = extractMsgId(data); // pra CITAR (quote) a mensagem da pessoa na resposta
  log(`[${inst.id}] -> agent (${grupo ? 'grupo' : 'dm'}) ${chatid}: ${text.slice(0, 80)}`);
  // O loading "editando/explicando" só aparece quando é TAREFA (pediram algo OU mandaram mídia).
  // Conversa normal = rápida e quietinha, só "digitando…" — nada de teatro massivo a toda hora.
  const isMediaTask = /\[(A pessoa mandou|Audio|V[íi]deo|Imagem)/i.test(text);
  const hasLink = /https?:\/\//i.test(String(text));
  const taskish = isMediaTask || hasLink || /\b(cria|criar|recri|gera|gerar|monta|montar|fa[çc]a|fazer|analis|resum|relat[óo]rio|busca|procura|puxa|puxar|manda|envia|enviar|liga|ligar|conecta|conectar|publica|agenda|agendar|cobra|proposta|or[çc]amento|estrutura|arte|imagem|v[íi]deo|post|carross|admin)\b/i.test(String(text));
  let thinkId = null, thinkTimer = null, thinkDelay = null, thinkCancelled = false, thinkMaxLife = null;
  {
    await setPresence(inst, chatid, 'composing');
    if (taskish) thinkDelay = setTimeout(async () => {
      if (thinkCancelled) return;
      const id = await sendTextReturningId(inst, chatid, nextThinkOpener(), replyId);
      if (thinkCancelled || !id) return; // resposta chegou enquanto o loading era enviado
      thinkId = id;
      thinkTimer = setInterval(() => { editMsg(inst, thinkId, nextThinkPhrase()).catch(() => {}); }, 3800);
    }, THINK_DELAY_MS);
  }
  const finishThinking = () => {
    thinkCancelled = true;
    if (thinkDelay) { clearTimeout(thinkDelay); thinkDelay = null; }
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    if (thinkMaxLife) { clearTimeout(thinkMaxLife); thinkMaxLife = null; }
  };
  // rede de segurança: se QUALQUER caminho travar sem chamar finishThinking (await pendurado,
  // edição falhando), o "pensando" pararia de se editar mas ficaria preso pra sempre. Teto duro:
  thinkMaxLife = setTimeout(() => {
    if (thinkCancelled) return;
    log(`[${inst.id}] thinking excedeu teto — encerrando loading de ${chatid}`);
    finishThinking();
  }, (AGENT_TIMEOUT + 60) * 1000);
  thinkMaxLife.unref?.();

  let reply;
  try {
    reply = await runAgent(sk, message);
    if (!reply || !String(reply).trim()) {
      log(`[${inst.id}] resposta vazia, 1 retry...`);
      reply = await runAgent(sk, message);
    }
  } catch (e) {
    finishThinking();
    stats.errors++;
    log(`[${inst.id}] runAgent erro:`, e.message);
    // CONTENÇÃO: nunca deixar a pessoa no vácuo. Tenta editar o loading; se a edição falhar
    // (ex.: janela de edição do WhatsApp já expirou após uma espera longa), MANDA mensagem nova.
    const recado = 'Opa, esse pedido veio denso e eu me enrolei no meio 🙈 Me manda de novo (ou em pedaços) que eu pego certinho — prometo.';
    const editou = thinkId ? await editMsg(inst, thinkId, recado) : false;
    if (!editou) await sendText(inst, chatid, recado);
    return;
  }
  finishThinking();
  await setPresence(inst, chatid, 'available');
  if (!reply || !String(reply).trim()) {
    stats.empty++;
    const fallback = empresaHomeCarousel(chatid);
    fallback.text = 'Estou aqui. Escolhe por onde quer começar que eu continuo em carrossel.';
    if (thinkId) await editMsg(inst, thinkId, fallback.text);
    if (grupo && isInteractivePart(fallback)) await sendGroupInteractivePrivately(inst, chatid, data, fallback);
    else await sendPart(inst, chatid, fallback);
    stats.answered++; stats.lastAnswerAt = new Date().toISOString();
    log(`[${inst.id}] resposta vazia apos retry — fallback Empresa.ia enviado p/ ${chatid}`);
    return;
  }
  const { parts, actions } = parseAgentReply(reply);
  let sent = 0, startIdx = 0, quoted = !!thinkId; // se o "pensando" (já citado) virou a resposta, não cita de novo
  // a msg "pensando" VIRA o 1o texto da resposta (transição suave, sem mensagem solta)
  if (thinkId && parts.length) {
    const firstTextIdx = parts.findIndex(p => typeof p === 'string' && p.trim());
    if (firstTextIdx === 0) {
      await editMsg(inst, thinkId, parts[0]); sent++; startIdx = 1;
    } else if (firstTextIdx > 0) {
      await editMsg(inst, thinkId, parts[firstTextIdx]); sent++; parts.splice(firstTextIdx, 1);
    } else {
      await editMsg(inst, thinkId, 'achei, ó 👇');
    }
  }
  for (const p of parts.slice(startIdx)) {
    const rid = quoted ? null : replyId; // só a PRIMEIRA mensagem da resposta cita a pessoa
    if (grupo && isInteractivePart(p)) sent += (await sendGroupInteractivePrivately(inst, chatid, data, p)) || 0;
    else sent += (await sendPart(inst, chatid, p, rid)) || 0;
    quoted = true;
  }
  const senderIsOwner = isOwnerChatid(extractSenderChatid(data) || chatid);
  for (const a of actions) await runAction(inst, a, chatid, senderIsOwner);
  stats.answered++; stats.lastAnswerAt = new Date().toISOString();
  log(`[${inst.id}] <- respondeu ${chatid} (${parts.length} parte(s), ${sent} enviada(s))`);
  // painel 📊 Interações: quem falou, com qual funcionária, sobre o quê (clientes; o dono não se auto-reporta)
  try {
    const senderDigits = onlyDigits(extractSenderChatid(data) || chatid);
    if (!OWNER.includes(senderDigits) && !isReportGroup(chatid)) {
      const empAtiva = grupo ? (employeesById.get(getGroupSpeaker(chatid) || getGroupEmp(chatid) || '')?.name || 'Sofia') : 'Sofia';
      reportar(inst, 'interacoes', `💬 ${horaSP()} · *${nome || 'Contato'}* (${senderDigits})${grupo ? ' [grupo]' : ''} ↔ *${empAtiva}*\n“${String(text).replace(/\s+/g, ' ').slice(0, 100)}”`);
    }
  } catch (e) { log('[report] interacoes erro:', e.message); }
}

// ---------- 🎬 Estúdio de Vídeo (Vivi): módulo separado, com injeção de dependências ----------
let _videoStudio = null;
function videoStudio() {
  if (!_videoStudio) _videoStudio = require('./video-studio')({ log, sendText, uaz, downloadVideoBuffer, findVideoMessage, PUBLIC_DIR, ASSET_BASE, GROQ_API_KEY });
  return _videoStudio;
}

async function dispatch(inst, data, origin) {
  if (!data || isFromMe(data)) return;
  const chatid = extractChatid(data);
  const rawText = extractText(data);
  const hasAudio = !!findAudioMessage(data);
  const hasImage = !!findImageMessage(data);
  const hasVideo = !!findVideoMessage(data);
  const hasDoc = !!findDocumentMessage(data);
  if (!chatid || (!hasAudio && !hasImage && !hasVideo && !hasDoc && (!rawText || !String(rawText).trim()))) return;
  const grupo = isGroup(data);
  // grupo: responde quando mencionado OU se for um grupo dedicado da Empresa.ia (é "a casa" da funcionária)
  if (grupo && !isMentioned(data, inst) && !getGroupEmp(chatid)) return;
  // no grupo dedicado: a funcionária ATENDE todo mundo SEM precisar de menção (não cansa marcar).
  // Só não responde a acks curtos (ok/valeu) pra não ficar tagarela.
  if (grupo && getGroupEmp(chatid)) {
    const ack = String(rawText || '').trim().toLowerCase().replace(/[!.…👍🙏✅😉🙌👏🔥]/g, '').trim();
    if (!hasAudio && !hasImage && !hasVideo && ['ok', 'okk', 'blz', 'beleza', 'valeu', 'vlw', 'obrigado', 'obrigada', 'show', 'perfeito', 'isso', 'top', 'ótimo', 'otimo'].includes(ack)) return;
  }

  // dedup: mesma msg pode chegar por webhook E sse
  const mid = extractMsgId(data);
  if (alreadySeen(mid)) { stats.deduped++; return; }
  stats.received++; stats.lastInboundAt = new Date().toISOString();
  if (origin === 'webhook') stats.viaWebhook++; else if (origin === 'sse') stats.viaSSE++;

  // 🎬 grupo da Vivi: vídeo NÃO vai pro cérebro — entra direto no pipeline de edição (corte + legenda)
  if (grupo && hasVideo && getGroupEmp(chatid) === 'vivi') {
    videoStudio().processVideo(inst, chatid, data).catch(e => { stats.errors++; log('[estudio] erro:', e.message); });
    return;
  }

  let text = await enrichTextWithAudio(data, String(rawText || '').trim());
  text = await enrichTextWithImage(data, text);
  text = await enrichTextWithVideo(data, text);
  text = enrichTextWithDocument(data, text);

  // texto a enfileirar: em grupo, remove a menção crua (@lid) — o contexto entra no handle
  const toQueue = grupo ? (cleanMentions(text, inst) || '(mencionou você)') : String(text).trim();

  // debounce: agrupa mensagens em rajada do mesmo chat
  const key = chatid;
  const cur = pending.get(key) || { texts: [], data, waiters: [] };
  const done = new Promise((resolve, reject) => cur.waiters.push({ resolve, reject }));
  cur.texts.push(String(toQueue).trim());
  cur.data = data;
  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = setTimeout(() => {
    pending.delete(key);
    const joined = cur.texts.join('\n');
    const queued = enqueue(key, () => handle(inst, chatid, cur.data, joined), async () => {
      // backstop: o turno passou do watchdog sem responder — manda um recado pra não deixar no vácuo.
      try { await sendText(inst, chatid, 'Ô, essa eu travei feio e passou do tempo 🙈 Me chama de novo que eu pego na hora — pode ser em pedaços.'); } catch {}
    });
    queued.then(
      result => cur.waiters.splice(0).forEach(waiter => waiter.resolve(result)),
      error => cur.waiters.splice(0).forEach(waiter => waiter.reject(error)),
    );
  }, DEBOUNCE_MS);
  pending.set(key, cur);
  return done;
}

// extrai eventos de mensagem de um payload de webhook (formatos variados do uazapi)
function* iterMessages(payload) {
  if (!payload || typeof payload !== 'object') return;
  const et = payload.EventType || payload.type || payload.event;
  if (et && et !== 'messages') return;
  if (payload.chatid || payload.from || payload.key) yield payload;
  if (payload.message) yield payload.message;
  if (Array.isArray(payload.messages)) for (const m of payload.messages) yield m;
  if (Array.isArray(payload.data)) for (const m of payload.data) yield (m.message || m);
}

// ---------- SSE por instância (fallback) ----------
function startSSE(inst) {
  const url = `${inst.uazapi_url}/sse?token=${encodeURIComponent(inst.uazapi_token)}&events=messages&excludeMessages=fromMeYes`;
  let es = null, attempt = 0, lastEvent = Date.now(), lastRefresh = Date.now(), reconnecting = false;
  const reconnect = (why) => {
    if (reconnecting) return;           // evita conexões sobrepostas
    reconnecting = true;
    attempt += 1;
    const delay = Math.min(15000, 1000 * Math.min(attempt, 5)); // 1s..5s, teto 15s
    log(`[${inst.id}] SSE caiu (${why}); reconectando em ${Math.round(delay / 1000)}s [tentativa ${attempt}]`);
    try { es && es.close(); } catch {}
    setTimeout(() => { reconnecting = false; connect(); }, delay);
  };
  const connect = () => {
    try { es && es.close(); } catch {}
    es = new EventSource(url);
    es.onopen = () => { attempt = 0; lastEvent = Date.now(); lastRefresh = Date.now(); log(`[${inst.id}] SSE conectado (${inst.number})`); };
    es.onmessage = (ev) => {
      lastEvent = Date.now();
      try {
        const parsed = JSON.parse(ev.data);
        for (const m of iterMessages(parsed)) dispatch(inst, m, 'sse').catch(e => { stats.errors++; log('[sse] dispatch erro:', e.message); });
      } catch (e) { log(`[${inst.id}] parse SSE erro:`, e.message); }
    };
    es.onerror = (e) => reconnect(e?.message || 'onerror');
  };
  // watchdog: distingue conexão MORTA de conexão só QUIETA (pouco tráfego é normal).
  // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED. Silêncio com conexão ABERTA NÃO é problema —
  // o webhook (push do uazapi, com retry) é o canal primário e o dedup evita duplicar.
  // Só reconecta de fato quando a conexão fechou; e faz 1 refresh preventivo se ficar mudo +20min
  // (cobre "morte silenciosa": socket aberto mas morto), sem o loop barulhento de reconexão a cada 8min.
  setInterval(() => {
    if (!es) return;
    if (es.readyState === 2) { reconnect('watchdog: conexão fechada'); return; }
    if (es.readyState === 1
        && Date.now() - lastEvent > 20 * 60 * 1000
        && Date.now() - lastRefresh > 20 * 60 * 1000) {
      lastRefresh = Date.now();
      reconnect('watchdog: refresh preventivo (20min mudo)');
    }
  }, 60 * 1000).unref?.();
  connect();
}

// ---------- keep-warm (mata cold start de 24s) ----------
function startPrewarm() {
  if (PREWARM_MS <= 0) return;
  const tick = async () => { try { await runAgent('agent:main:keepwarm', 'ping'); } catch {} };
  setInterval(tick, PREWARM_MS).unref();
  tick();
}

// ---------- main ----------
const instById = new Map(CFG.map(i => [i.id, i]));

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

function serveAsset(req, res, url) {
  // aceita 1 nível de subpasta (ex: reels/x.mp4) — segmentos seguros, sem path traversal
  const rawName = decodeURIComponent(url.replace(/^\/assets\//, '').split('?')[0] || '');
  if (!/^([a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp|ogg|oga|mp3|m4a|mp4|mov)$/i.test(rawName) || rawName.includes('..')) {
    res.writeHead(404); res.end('not found'); return true;
  }
  const file = `${PUBLIC_DIR}/${rawName}`;
  if (!fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return true;
  }
  const ext = rawName.toLowerCase().split('.').pop();
  const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime' };
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(file);
  // Range requests: o Instagram/players pedem pedaços do vídeo — sem isso o download do Reel falha
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = s ? parseInt(s, 10) : 0;
    const end = e ? parseInt(e, 10) : stat.size - 1;
    if (start > end || end >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
  return true;
}

function startHttpServer() {
  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/assets/')) return serveAsset(req, res, url);
    // health
    if (req.method === 'GET' && (url === '/' || url.startsWith('/health'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, instances: CFG.map(i => ({ id: i.id, number: i.number })), pending: pending.size, stats }));
    }
    // mid-call tool AutoCalls: POST /autocalls/tool/<secret>
    if (req.method === 'POST' && url.startsWith('/autocalls/tool')) {
      if (WEBHOOK_SECRET) {
        const given = url.split('/')[3] || '';
        if (given !== WEBHOOK_SECRET) { res.writeHead(403); return res.end('forbidden'); }
      }
      const raw = await readBody(req);
      try {
        const payload = JSON.parse(raw || '{}');
        const result = await handleAutoCallsTool(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        stats.errors++;
        log('[autocalls] tool erro:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // webhook AutoCalls: POST /autocalls/<secret>
    if (req.method === 'POST' && url.startsWith('/autocalls')) {
      if (WEBHOOK_SECRET) {
        const given = url.split('/')[2] || '';
        if (given !== WEBHOOK_SECRET) { res.writeHead(403); return res.end('forbidden'); }
      }
      const raw = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      try {
        const payload = JSON.parse(raw || '{}');
        handleAutoCallsWebhook(payload).catch(e => { stats.errors++; log('[autocalls] webhook erro:', e.message); });
      } catch (e) { log('[autocalls] parse erro:', e.message); }
      return;
    }
    // webhook: POST /hook/<secret> (ou /hook se secret vazio)
    if (req.method === 'POST' && url.startsWith('/hook')) {
      if (WEBHOOK_SECRET) {
        const given = url.split('/')[2] || '';
        if (given !== WEBHOOK_SECRET) { res.writeHead(403); return res.end('forbidden'); }
      }
      const raw = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); // responde rápido, processa async
      try {
        const payload = JSON.parse(raw || '{}');
        const inst = instById.get(payload.instanceId) || instById.get(payload.id) || CFG[0];
        for (const m of iterMessages(payload)) dispatch(inst, m, 'webhook').catch(e => { stats.errors++; log('[webhook] dispatch erro:', e.message); });
      } catch (e) { log('[webhook] parse erro:', e.message); }
      return;
    }
    res.writeHead(404); res.end('not found');
  }).listen(HEALTH_PORT, BIND_HOST, () => log(`http (health+webhook) em http://${BIND_HOST}:${HEALTH_PORT}`));
}

function startBridge() {
  // rede de segurança do processo: uma rejection perdida (socket hang up, stream de webhook
  // abortado) NÃO pode derrubar o bridge inteiro e matar o atendimento de todo mundo.
  process.on('unhandledRejection', (e) => { stats.errors++; log('[FATAL-evitado] unhandledRejection:', e?.message || e); });
  process.on('uncaughtException', (e) => { stats.errors++; log('[FATAL-evitado] uncaughtException:', e?.message || e, (e?.stack || '').split('\n')[1] || ''); });
  if (!WEBHOOK_SECRET) {
    log('⚠️  WEBHOOK_SECRET vazio: /hook, /autocalls e /autocalls/tool estão SEM autenticação — '
      + 'qualquer um que descubra a URL injeta mensagens. Configure WEBHOOK_SECRET no .env!');
  }
  for (const inst of CFG) { if (ENABLE_SSE) startSSE(inst); }
  startPrewarm();
  startDudaDigest();
  startIgAutoreply();
  startAgendador(CFG[0]);
  startRelatorioMetricas(CFG[0]);
  const server = startHttpServer();
  log('Empresa.ia bridge no ar. Instâncias:', CFG.map(i => i.id).join(', '),
    `| SSE:${ENABLE_SSE ? 'on' : 'off'} | webhook:/hook${WEBHOOK_SECRET ? '/<secret>' : ''} | prewarm:${PREWARM_MS || 'off'}`);
  return server;
}

if (require.main === module) {
  startBridge();
}

module.exports = {
  extractText,
  iterMessages,
  empresaiaResponseFor,
  recordEmpresaiaUsage,
  empresaiaUsageProfile,
  employees,
  employeeVariables,
  employeeWavoCallPayload,
  makeEmployeeWavoCall,
  makeEmployeeCall,
  upsertLead,
  loadLeads,
  leadsResumo,
  extractAutoCallsContext,
  handleAutoCallsWebhook,
  handleAutoCallsTool,
  dispatch,
  startBridge,
  stats,
  boasVindasRico,
  isOwnerChatid,
  isSaudacao,
  isDemoTrigger,
  vitrineCarousel,
  extrairNome,
  roteiroPersonalizado,
  onboardPerguntaNome,
  onboardPerguntaNicho,
  fichaContexto,
  CAPACIDADES_REMINDER,
};
