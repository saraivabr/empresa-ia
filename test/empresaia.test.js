const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const test = require('node:test');

const tmp = mkdtempSync(join(tmpdir(), 'empresaia-bridge-'));
const usageFile = join(tmp, 'usage.json');

process.env.INSTANCES_FILE = join(tmp, 'instances.json');
process.env.EMPRESAIA_USAGE_FILE = usageFile;
process.env.ASSET_BASE = 'http://assets.local/';
process.env.ENABLE_SSE = '0';
process.env.PREWARM_MS = '0';
process.env.DEBOUNCE_MS = '10';
process.env.OWNER_NUMBERS = '5519900000001';

writeFileSync(process.env.INSTANCES_FILE, JSON.stringify([
  {
    id: 'jesus',
    number: '5519900000002',
    uazapi_url: 'http://127.0.0.1:9',
    uazapi_token: 'test-token',
  },
]));

const bridge = require('../bridge.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(fn, timeoutMs = 800) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(25);
  }
  return fn();
}

function startFakeUazapi() {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const close = () => new Promise(done => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      });
      resolve({ server, close, calls, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('extractText prefers concrete message text instead of object coercion', () => {
  assert.equal(bridge.extractText({
    message: {
      key: { remoteJid: '5519900000001@s.whatsapp.net' },
      message: { conversation: '@apps' },
    },
  }), '');

  assert.equal(bridge.extractText({
    key: { remoteJid: '5519900000001@s.whatsapp.net' },
    message: { conversation: '@apps' },
  }), '@apps');

  assert.equal(bridge.extractText({
    buttonOrListid: 'apps_meta_vencedor',
    message: { conversation: 'ignored' },
  }), 'apps_meta_vencedor');
});

test('iterMessages unwraps UAZAPI webhook payloads', () => {
  const payload = {
    event: 'messages',
    message: {
      key: { remoteJid: '5519900000001@s.whatsapp.net', id: 'msg-1' },
      message: { conversation: '@apps' },
    },
  };

  const messages = [...bridge.iterMessages(payload)];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.conversation, '@apps');
});

test('@equipe abre a vitrine das 7 especialistas com botoes talk e call', () => {
  const response = bridge.empresaiaResponseFor('@equipe', true, '5519900000001@s.whatsapp.net');

  assert.ok(response);
  assert.ok(Array.isArray(response.carousel));
  assert.equal(response.carousel.length, 7);
  assert.ok(response.carousel.every(card => card.image.startsWith('http://assets.local/')));
  assert.ok(response.carousel.every(card => card.buttons.length <= 3));
  const clara = response.carousel.find(card => /Clara/.test(card.text));
  assert.ok(clara);
  assert.ok(clara.buttons.some(button => button.id === 'talk_clara'));
  assert.ok(clara.buttons.some(button => button.id === 'call_employee_clara'));
});

test('texto livre nao empurra menu (pull-only) e vai pro agente', () => {
  // mensagens em linguagem natural devem retornar null para que a Sofia (agente) converse
  assert.equal(bridge.empresaiaResponseFor('quero ver campanhas e cortar verba ruim', true, '5519900000001@s.whatsapp.net'), null);
  assert.equal(bridge.empresaiaResponseFor('me liga sobre financeiro e caixa', true, '5519900000001@s.whatsapp.net'), null);
  assert.equal(bridge.empresaiaResponseFor('oi tudo bem?', true, '5519900000001@s.whatsapp.net'), null);
});

test('@empresa abre a vitrine da equipe', () => {
  const response = bridge.empresaiaResponseFor('@empresa', true, '5519900000001@s.whatsapp.net');

  assert.ok(response);
  assert.equal(response.carousel.length, 7);
  assert.ok(response.carousel.some(card => /Sofia/.test(card.text)));
});

test('@resumo abre o relatorio do dia por setor', () => {
  const response = bridge.empresaiaResponseFor('@resumo', true, '5519900000001@s.whatsapp.net');

  assert.ok(response);
  assert.ok(Array.isArray(response.carousel));
  // relatorio exclui a gerente (Sofia): 6 setores
  assert.equal(response.carousel.length, 6);
  assert.ok(response.carousel.every(card => card.buttons.length >= 1));
});

test('dispatch sends @equipe as /send/carousel to UAZAPI', async () => {
  const fake = await startFakeUazapi();
  try {
    const inst = {
      id: 'jesus',
      number: '5519900000002',
      uazapi_url: fake.url,
      uazapi_token: 'test-token',
    };

    await bridge.dispatch(inst, {
      key: {
        remoteJid: '5519900000001@s.whatsapp.net',
        fromMe: false,
        id: 'msg-dispatch-apps',
      },
      message: { conversation: '@equipe' },
      pushName: 'TestUser',
    }, 'webhook');

    await sleep(80);

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, 'POST');
    assert.equal(fake.calls[0].url, '/send/carousel');
    assert.equal(fake.calls[0].headers.token, 'test-token');
    assert.equal(fake.calls[0].body.number, '5519900000001@s.whatsapp.net');
    assert.ok(Array.isArray(fake.calls[0].body.carousel));
    assert.ok(fake.calls[0].body.carousel[0].image.startsWith('http://assets.local/'));
    assert.equal(bridge.stats.answered, 1);
  } finally {
    await fake.close();
  }
});

test('@funcionarios abre a vitrine com 7 especialistas', () => {
  const response = bridge.empresaiaResponseFor('@funcionarios', true, '5519900000001@s.whatsapp.net');

  assert.equal(bridge.employees.filter(e => !e.internal).length, 7);
  assert.ok(Array.isArray(response.carousel));
  assert.equal(response.carousel.length, 7);
  const clara = response.carousel.find(card => card.buttons.some(button => button.id === 'call_employee_clara'));
  assert.ok(clara);
  assert.match(clara.text, /Clara/);
});

test('employee detail traz setor, solucao e acao de ligacao', () => {
  const response = bridge.empresaiaResponseFor('employee_clara', true, '5519900000001@s.whatsapp.net');

  assert.ok(response);
  const card = response.carousel[0];
  assert.match(card.text, /Clara/);
  assert.match(card.text, /Vendas/);
  assert.ok(card.buttons.some(button => button.id === 'call_employee_clara'));
});

test('employee call variables include dynamic prompt and operational context', () => {
  const employee = bridge.employees.find(item => item.id === 'clara');
  const vars = bridge.employeeVariables(employee, '5519900000001@s.whatsapp.net', { pushName: 'TestUser' }, 'call_employee_clara');

  assert.equal(vars.employee_id, 'clara');
  assert.equal(vars.employee_name, 'Clara');
  assert.equal(vars.employee_role, employee.role);
  assert.equal(vars.employee_sector, employee.category);
  assert.equal(vars.mission, employee.mission);
  assert.equal(vars.solution, employee.solution);
  assert.equal(vars.insight, employee.insight);
  assert.equal(vars.customer_phone, '+5519900000001');
  assert.equal(vars.customer_name, 'TestUser');
  assert.equal(vars.whatsapp_chatid, '5519900000001@s.whatsapp.net');
  assert.equal(vars.trigger_text, 'call_employee_clara');
  assert.match(vars.dynamic_prompt, /Voce e Clara/);
  assert.match(vars.dynamic_prompt, /Nunca finja acesso/);
  assert.doesNotMatch(JSON.stringify(vars), /autocalls/i);
});

test('employee WavoIP call payload carries WhatsApp voice context', () => {
  const employee = bridge.employees.find(item => item.id === 'clara');
  const payload = bridge.employeeWavoCallPayload(employee, '5519900000001@s.whatsapp.net', { pushName: 'TestUser' }, 'call_employee_clara');

  assert.equal(payload.to, '+5519900000001');
  assert.equal(payload.phone, '+5519900000001');
  assert.equal(payload.number, '5519900000001');
  assert.equal(payload.channel, 'whatsapp');
  assert.equal(payload.source, 'empresaia_whatsapp_carousel');
  assert.equal(payload.employee_id, 'clara');
  assert.equal(payload.variables.employee_name, 'Clara');
  assert.equal(payload.dynamic_variables.whatsapp_chatid, '5519900000001@s.whatsapp.net');
  assert.equal(payload.conversation_initiation_client_data.dynamic_variables.employee_id, 'clara');
  assert.match(payload.variables.dynamic_prompt, /Voce e Clara/);
});

test('dispatch starts the call via autocalls when employee call button is clicked', async () => {
  const fake = await startFakeUazapi();
  const previousAutoBase = process.env.AUTOCALLS_BASE_URL;
  const previousAutoKey = process.env.AUTOCALLS_API_KEY;
  const previousAutoAssistant = process.env.AUTOCALLS_ASSISTANT_ID;
  process.env.AUTOCALLS_BASE_URL = fake.url;
  process.env.AUTOCALLS_API_KEY = 'test-autocalls-key';
  process.env.AUTOCALLS_ASSISTANT_ID = '42';

  try {
    const inst = {
      id: 'jesus',
      number: '5519900000002',
      uazapi_url: fake.url,
      uazapi_token: 'test-token',
    };

    await bridge.dispatch(inst, {
      key: {
        remoteJid: '5519900000001@s.whatsapp.net',
        fromMe: false,
        id: 'msg-dispatch-call-clara',
      },
      buttonOrListid: 'call_employee_clara',
      pushName: 'TestUser',
    }, 'webhook');

    const callRequest = await waitUntil(() => fake.calls.find(call => call.url === '/api/user/make_call'));
    const whatsappAck = await waitUntil(() => fake.calls.find(call => call.url === '/send/text'));

    assert.ok(callRequest);
    assert.equal(callRequest.method, 'POST');
    assert.equal(callRequest.headers.authorization, 'Bearer test-autocalls-key');
    assert.equal(callRequest.body.phone_number, '+5519900000001');
    assert.equal(callRequest.body.assistant_id, 42);
    assert.equal(callRequest.body.variables.employee_id, 'clara');
    assert.equal(callRequest.body.variables.employee_name, 'Clara');
    assert.equal(callRequest.body.variables.whatsapp_chatid, '5519900000001@s.whatsapp.net');
    assert.equal(callRequest.body.variables.trigger_text, 'call_employee_clara');
    assert.match(callRequest.body.variables.dynamic_prompt, /Voce e Clara/);
    assert.ok(whatsappAck);
    assert.match(whatsappAck.body.text, /Clara esta te ligando pelo WhatsApp/);
  } finally {
    if (previousAutoBase) process.env.AUTOCALLS_BASE_URL = previousAutoBase;
    else delete process.env.AUTOCALLS_BASE_URL;
    if (previousAutoKey) process.env.AUTOCALLS_API_KEY = previousAutoKey;
    else delete process.env.AUTOCALLS_API_KEY;
    if (previousAutoAssistant) process.env.AUTOCALLS_ASSISTANT_ID = previousAutoAssistant;
    else delete process.env.AUTOCALLS_ASSISTANT_ID;
    await fake.close();
  }
});

test('dispatch reports call setup gap without exposing internal provider details', async () => {
  const fake = await startFakeUazapi();
  const previousAutoKey = process.env.AUTOCALLS_API_KEY;
  const previousAutoAssistant = process.env.AUTOCALLS_ASSISTANT_ID;
  delete process.env.AUTOCALLS_API_KEY;
  delete process.env.AUTOCALLS_ASSISTANT_ID;

  try {
    const inst = {
      id: 'jesus',
      number: '5519900000002',
      uazapi_url: fake.url,
      uazapi_token: 'test-token',
    };

    await bridge.dispatch(inst, {
      key: {
        remoteJid: '5519900000003@s.whatsapp.net',
        fromMe: false,
        id: 'msg-dispatch-call-clara-missing-wavoip',
      },
      buttonOrListid: 'call_employee_clara',
      pushName: 'TestUser',
    }, 'webhook');

    assert.ok(!fake.calls.some(call => call.url === '/api/user/make_call'));
    const ackText = await waitUntil(() => {
      const text = fake.calls.filter(call => call.url === '/send/text').map(call => call.body.text).join('\n');
      return /tentar de novo/.test(text) ? text : '';
    });
    assert.ok(ackText);
    assert.match(ackText, /chamada nao iniciou/);
    assert.match(ackText, /tentar de novo/);
    assert.doesNotMatch(ackText, /WAVOIP|AUTOCALLS|BASE_URL|API|endpoint/i);
  } finally {
    if (previousAutoKey) process.env.AUTOCALLS_API_KEY = previousAutoKey;
    else delete process.env.AUTOCALLS_API_KEY;
    if (previousAutoAssistant) process.env.AUTOCALLS_ASSISTANT_ID = previousAutoAssistant;
    else delete process.env.AUTOCALLS_ASSISTANT_ID;
    await fake.close();
  }
});

test('post-call webhook payload resolves employee and extracted summary', () => {
  const context = bridge.extractAutoCallsContext({
    id: 123,
    status: 'completed',
    extracted_variables: {
      status: true,
      summary: 'Cliente aprovou receber o proximo passo no WhatsApp.',
    },
    input_variables: {
      employee_id: 'clara',
      employee_name: 'Clara',
      whatsapp_chatid: '5519900000001@s.whatsapp.net',
    },
    formatted_transcript: 'AI: Oi, aqui e Clara.\nCliente: Pode mandar.',
  });

  assert.equal(context.employee.name, 'Clara');
  assert.equal(context.input.whatsapp_chatid, '5519900000001@s.whatsapp.net');
  assert.equal(context.extracted.status, true);
  assert.match(context.transcript, /Pode mandar/);
});

test('mid-call tool returns employee guidance without forcing whatsapp send', async () => {
  const result = await bridge.handleAutoCallsTool({
    employee_id: 'helena',
    intent: 'orientar_proximo_passo',
    finding: 'Recebiveis atrasados acima do esperado.',
    next_step: 'separar cobrancas de alto valor para hoje',
    urgency: 8,
    input_variables: {
      whatsapp_chatid: '5519900000001@s.whatsapp.net',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.employee_name, 'Helena');
  assert.equal(result.urgency, 8);
  assert.equal(result.whatsapp_status, 'not_requested');
  assert.match(result.voice_guidance, /Recebiveis atrasados/);
});

test('talk_<id> envia audio de voz (ptt) da especialista e abre o detalhe', async () => {
  const fake = await startFakeUazapi();
  try {
    const inst = {
      id: 'jesus',
      number: '5519900000002',
      uazapi_url: fake.url,
      uazapi_token: 'test-token',
    };

    await bridge.dispatch(inst, {
      key: {
        remoteJid: '5519900000099@s.whatsapp.net',
        fromMe: false,
        id: 'msg-talk-clara',
      },
      buttonOrListid: 'talk_clara',
      pushName: 'TestUser',
    }, 'webhook');

    const media = await waitUntil(() => fake.calls.find(call => call.url === '/send/media'));
    assert.ok(media);
    assert.equal(media.body.type, 'ptt');
    assert.match(media.body.file, /audio-clara\.ogg/);

    const carousel = await waitUntil(() => fake.calls.find(call => call.url === '/send/carousel'));
    assert.ok(carousel);
    assert.match(carousel.body.carousel[0].text, /Clara/);
  } finally {
    await fake.close();
  }
});
