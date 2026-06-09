async function handleAutoCallsTool(payload) {
  const input = objectAt(payload.input_variables, payload.inputVariables, payload.variables, payload.data?.input_variables, payload.data?.variables);
  const chatid = String(input.whatsapp_chatid || payload.whatsapp_chatid || payload.customer_phone || '').trim();
  const employeeId = String(payload.employee_id || input.employee_id || payload.sector_employee_id || '').toLowerCase();
  const employee = employeesById.get(employeeId) || null;
  const tarefa = String(payload.tarefa || payload.pergunta || payload.query || payload.request || payload.message || payload.intent || payload.acao || '').trim();
  if (!tarefa) {
    return { ok: false, error: 'tarefa vazia', voice_guidance: 'Pergunte ao cliente o que ele precisa exatamente e tente de novo.' };
  }
  const sk = sessionKeyFor(chatid || ('autocalls-' + (employeeId || 'geral')));
  const persona = employee ? ('Voce atua como ' + employee.name + ' (' + employee.role + '). ') : '';
  const prompt = '[Pedido feito DURANTE uma LIGACAO de voz ao vivo com o dono. ' + persona +
    'Execute a tarefa de verdade usando suas skills e ferramentas reais. Se gerar algo para o WhatsApp (link, resumo, imagem, botao, contrato), use as diretivas <uazapi> normalmente: sera entregue no WhatsApp dele em tempo real, durante a ligacao. ' +
    'Seu texto de resposta sera LIDO EM VOZ ALTA na ligacao, entao seja curto, natural e direto (no maximo 2 ou 3 frases), sem markdown, sem listas e sem emojis no texto falado.]\n\nTarefa: ' + tarefa;
  let reply = '';
  try {
    reply = await runAgent(sk, prompt);
  } catch (e) {
    stats.errors++;
    log('[autocalls-tool] openclaw erro: ' + e.message);
    return { ok: false, error: e.message, voice_guidance: 'Diga que tive um probleminha tecnico para puxar isso agora e que ja tento de novo.' };
  }
  const parsed = parseAgentReply(reply);
  const spoken = [];
  for (const p of (parsed.parts || [])) {
    if (typeof p === 'string') spoken.push(p);
    else if (chatid) { try { await sendPart(CFG[0], chatid, p); } catch (e) { stats.errors++; } }
  }
  for (const a of (parsed.actions || [])) { try { await runAction(CFG[0], a); } catch (e) {} }
  let voiceText = spoken.join(' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!voiceText) voiceText = 'Pronto, ja cuidei disso e o que precisava ja esta indo pro seu WhatsApp.';
  log('[autocalls-tool] tarefa=' + tarefa.slice(0, 60) + ' -> ' + voiceText.slice(0, 80));
  return { ok: true, result: voiceText, response: voiceText, voice_guidance: voiceText, whatsapp_chatid: chatid || null };
}
