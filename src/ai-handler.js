/**
 * AI HANDLER — Logica IA con debounce + throttle + typing simulation
 * Best practices Baileys 2026:
 *  - Debounce 30s: agrupa mensajes rapidos del mismo cliente en uno
 *  - Throttle 60s: minimo entre respuestas al mismo chat
 *  - Typing simulation: muestra "escribiendo..." antes de enviar
 *  - Rate limit: max 6 msgs/hora por chat, 100/hora total
 *
 * RPCs Supabase usadas (creadas por v5.42 migration):
 *  - oasis_enqueue_for_debounce(store, chat, content, msg_id)
 *  - oasis_should_bot_respond(store, chat)
 *  - oasis_log_bot_response(store, chat, content, delay, provider, typed)
 *
 * Vars de entorno necesarias en Render:
 *  - STORE_ID         (default: 00000000-0000-0000-0000-000000000001 = Sanate)
 *  - GEMINI_API_KEY   (API key Gemini para generar respuestas)
 *  - GEMINI_MODEL     (default: gemini-2.0-flash-exp)
 *  - SYSTEM_PROMPT    (prompt del bot, opcional)
 */

const STORE_ID = process.env.STORE_ID || '00000000-0000-0000-0000-000000000001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';

const debounceTimers = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processIncomingForAI(supabase, sock, chatId, content, msgId) {
  if (!supabase || !sock) return;
  if (!content || content.length < 1) return;

  try {
    const { data: enq, error: enqErr } = await supabase.rpc('oasis_enqueue_for_debounce', {
      p_store_id: STORE_ID,
      p_chat_jid: chatId,
      p_content: content,
      p_message_id: msgId
    });
    if (enqErr) { console.warn('[ai] enqueue err', enqErr.message); return; }

    console.log('[ai] queued ' + enq.action + ' chat=' + chatId.slice(0, 18) + ' qid=' + enq.queue_id);

    if (debounceTimers.has(chatId)) clearTimeout(debounceTimers.get(chatId));

    const debounceUntilMs = new Date(enq.debounce_until).getTime();
    const waitMs = Math.max(500, debounceUntilMs - Date.now() + 500);

    const timer = setTimeout(async () => {
      debounceTimers.delete(chatId);
      await processQueuedMessage(supabase, sock, enq.queue_id, chatId);
    }, waitMs);

    debounceTimers.set(chatId, timer);
  } catch (e) {
    console.error('[ai] processIncoming err:', e.message);
  }
}

async function processQueuedMessage(supabase, sock, queueId, chatId) {
  try {
    const { data: queueRow } = await supabase
      .from('oasis_wa_msg_queue').select('*').eq('id', queueId).single();

    if (!queueRow || queueRow.status !== 'pending') {
      console.log('[ai] queue ' + queueId + ' not pending, skip');
      return;
    }

    const { data: should } = await supabase.rpc('oasis_should_bot_respond', {
      p_store_id: STORE_ID, p_chat_jid: chatId
    });

    if (!should || !should.should_respond) {
      console.log('[ai] throttled chat=' + chatId.slice(0, 18) + ' reason=' + (should && should.reason));
      await supabase.from('oasis_wa_msg_queue').update({
        status: 'skipped_throttle',
        processed_at: new Date().toISOString(),
        error_msg: should && should.reason
      }).eq('id', queueId);
      return;
    }

    const t0 = Date.now();
    const aiResponse = await callGemini(queueRow.incoming_content);
    const aiLatency = Date.now() - t0;

    if (!aiResponse) {
      await supabase.from('oasis_wa_msg_queue').update({
        status: 'error_ai',
        processed_at: new Date().toISOString(),
        error_msg: 'no_response_from_gemini'
      }).eq('id', queueId);
      return;
    }

    if (should.typing_simulation) {
      try { await sock.sendPresenceUpdate('composing', chatId); } catch (e) { }
      const typingMs = Math.min(15000, (aiResponse.length / (should.typing_speed || 40)) * 1000);
      await sleep(typingMs);
      try { await sock.sendPresenceUpdate('paused', chatId); } catch (e) { }
    } else {
      await sleep((should.delay_secs || 10) * 1000);
    }

    await sock.sendMessage(chatId, { text: aiResponse });

    await supabase.rpc('oasis_log_bot_response', {
      p_store_id: STORE_ID,
      p_chat_jid: chatId,
      p_content: aiResponse,
      p_delay_used: should.delay_secs,
      p_provider: 'gemini',
      p_typed: !!should.typing_simulation
    });

    await supabase.from('oasis_wa_msg_queue').update({
      status: 'sent',
      processed_at: new Date().toISOString(),
      ai_response: aiResponse,
      ai_provider: 'gemini',
      ai_latency_ms: aiLatency
    }).eq('id', queueId);

    console.log('[ai] sent chat=' + chatId.slice(0, 18) + ' latency=' + aiLatency + 'ms reply_len=' + aiResponse.length);
  } catch (e) {
    console.error('[ai] processQueue err:', e.message);
    try {
      await supabase.from('oasis_wa_msg_queue').update({
        status: 'error_exception',
        processed_at: new Date().toISOString(),
        error_msg: (e.message || '').substring(0, 500)
      }).eq('id', queueId);
    } catch (e2) { }
  }
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    console.warn('[ai] GEMINI_API_KEY no configurada');
    return null;
  }

  try {
    const systemPrompt = process.env.SYSTEM_PROMPT ||
      'Eres un asistente de Sanate, marca de jabones naturales artesanales. Responde de forma amable, cercana y breve (maximo 60 palabras). Si preguntan precios o info de combos, ofrece el catalogo. Usa emojis con moderacion. No inventes datos.';

    const fullPrompt = systemPrompt + '\n\nCliente: ' + prompt + '\n\nRespuesta:';

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 200 }
        })
      }
    );

    if (!response.ok) {
      console.error('[ai] Gemini HTTP ' + response.status);
      return null;
    }

    const data = await response.json();
    const text = data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    return text ? text.trim() : null;
  } catch (e) {
    console.error('[ai] Gemini err:', e.message);
    return null;
  }
}

module.exports = { processIncomingForAI };
