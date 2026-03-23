/**
 * SUPABASE - Conexion a tu base de datos existente
 *
 * Tablas que YA existen en tu Supabase:
 * - oasis_wa_chats    (jid, name, phone, last_message, last_timestamp, unread, tags, lifecycle_stage)
 * - oasis_wa_messages  (chat_jid, chat_name, message_id, direction, content, media_type, media_url, timestamp)
 *
 * Este modulo escribe directamente en esas tablas.
 */

const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.warn('SUPABASE_URL o SUPABASE_SERVICE_KEY no estan configurados.');
    console.warn('El servidor funcionara pero sin persistencia de datos.');
    return null;
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false }
  });

  const projectRef = url.split('//')[1]?.split('.')[0] || 'unknown';
  console.log(`Supabase conectado: ${projectRef}`);
  return supabase;
}

function getSupabase() {
  return supabase;
}

// ========================================================
// GUARDAR MENSAJE en oasis_wa_messages
// ========================================================
async function saveMessage(chatJid, chatName, msgData) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('oasis_wa_messages')
      .upsert({
        chat_jid: chatJid,
        chat_name: chatName || chatJid.split('@')[0],
        message_id: msgData.messageId,
        direction: msgData.fromMe ? 's' : 'r',
        content: msgData.text || null,
        media_type: msgData.type !== 'text' ? msgData.type : null,
        media_url: msgData.mediaUrl || null,
        timestamp: msgData.timestamp
          ? new Date(typeof msgData.timestamp === 'number' && msgData.timestamp < 1e12
              ? msgData.timestamp * 1000
              : msgData.timestamp
            ).toISOString()
          : new Date().toISOString(),
        device_id: 'default'
      }, { onConflict: 'message_id', ignoreDuplicates: true });

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error guardando mensaje:', err.message);
    return null;
  }
}

// ========================================================
// GUARDAR/ACTUALIZAR CHAT en oasis_wa_chats
// ========================================================
async function upsertChat(chatJid, chatName, lastMessage, lastTimestamp) {
  if (!supabase) return null;
  try {
    const phone = chatJid.includes('@') ? chatJid.split('@')[0] : chatJid;

    const ts = lastTimestamp
      ? new Date(typeof lastTimestamp === 'number' && lastTimestamp < 1e12
          ? lastTimestamp * 1000
          : lastTimestamp
        ).toISOString()
      : new Date().toISOString();

    const { error } = await supabase
      .from('oasis_wa_chats')
      .upsert({
        jid: chatJid,
        name: chatName || phone,
        phone: phone,
        push_name: chatName || null,
        last_message: lastMessage,
        last_timestamp: ts,
        unread: 0,
        device_id: 'default',
        tags: '[]',
        lifecycle_stage: 'new',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'jid',
        ignoreDuplicates: false
      });

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Error guardando chat:', err.message);
    return null;
  }
}

// ========================================================
// OBTENER CHATS (para el dashboard)
// ========================================================
async function getChats(limit = 100) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('oasis_wa_chats')
      .select('*')
      .order('last_timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error obteniendo chats:', err.message);
    return [];
  }
}

// ========================================================
// OBTENER MENSAJES DE UN CHAT (para el dashboard)
// ========================================================
async function getMessages(chatJid, limit = 50, before = null) {
  if (!supabase) return [];
  try {
    let query = supabase
      .from('oasis_wa_messages')
      .select('*')
      .eq('chat_jid', chatJid)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('timestamp', before);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).reverse();
  } catch (err) {
    console.error('Error obteniendo mensajes:', err.message);
    return [];
  }
}

// ========================================================
// SYNC INICIAL: Guardar ultimos 15 chats con 20 msgs c/u
// ========================================================
async function syncInitialChats(chatsData) {
  if (!supabase) return { synced: 0, errors: 0 };

  let synced = 0;
  let errors = 0;

  console.log(`Sincronizando ${chatsData.length} chats a Supabase...`);

  for (const chat of chatsData) {
    try {
      await upsertChat(
        chat.jid,
        chat.name,
        chat.lastMessage,
        chat.lastTimestamp
      );

      if (chat.messages && chat.messages.length > 0) {
        for (const msg of chat.messages) {
          await saveMessage(chat.jid, chat.name, msg);
        }
      }

      synced++;
      console.log(`  OK ${chat.name || chat.jid.split('@')[0]} (${chat.messages?.length || 0} msgs)`);
    } catch (err) {
      errors++;
      console.error(`  Error ${chat.jid}: ${err.message}`);
    }
  }

  console.log(`Sync completado: ${synced} OK, ${errors} errores`);
  return { synced, errors };
}

module.exports = {
  initSupabase,
  getSupabase,
  saveMessage,
  upsertChat,
  getChats,
  getMessages,
  syncInitialChats
};
