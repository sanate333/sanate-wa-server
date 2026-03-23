/**
 * API ROUTES - Endpoints exactos que usa tu dashboard
 *
 * Tu dashboard (sanate.store) llama a estos endpoints:
 * GET  /api/whatsapp/status              -> Estado de conexion
 * GET  /api/whatsapp/chats               -> Lista de chats
 * GET  /api/whatsapp/chats/:id/messages  -> Mensajes de un chat
 * GET  /api/whatsapp/chats/:id/photo     -> Foto de perfil
 * GET  /api/whatsapp/events              -> SSE tiempo real
 * GET  /api/whatsapp/qr                  -> QR para vincular
 * GET  /api/whatsapp/settings            -> Config del servidor
 * POST /api/whatsapp/send                -> Enviar mensaje
 * POST /api/whatsapp/disconnect          -> Desconectar
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');

const {
  getConnectionState,
  getQR,
  getProfilePhoto,
  getContactName,
  sendMessage,
  disconnect,
  getSocket,
  contactCache
} = require('./baileys');

const {
  getChats,
  getMessages
} = require('./supabase');

// === AUTH MIDDLEWARE ===
function auth(req, res, next) {
  const openPaths = ['/events', '/status', '/qr', '/settings'];
  if (openPaths.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }

  if (process.env.API_SECRET) {
    const token = req.headers.authorization?.replace('Bearer ', '')
      || req.query.token
      || req.headers['x-api-key'];

    if (token !== process.env.API_SECRET) {
      const origin = req.headers.origin || req.headers.referer || '';
      if (!origin.includes('sanate.store')) {
        return res.status(401).json({ error: 'No autorizado' });
      }
    }
  }

  next();
}

router.use(auth);

// ============================================
// 1. STATUS
// ============================================
router.get('/status', (req, res) => {
  res.json({
    status: getConnectionState(),
    connected: getConnectionState() === 'connected',
    hasQR: !!getQR(),
    uptime: Math.floor(process.uptime()),
    sseClients: req.app.get('sse')?.getStatus()?.clients || 0,
    contactsInCache: contactCache.keys().length,
    server: 'sanate-wa-server',
    engine: 'baileys-standalone',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// 2. QR CODE
// ============================================
router.get('/qr', async (req, res) => {
  const qr = getQR();
  const state = getConnectionState();

  if (state === 'connected') {
    return res.json({ status: 'connected', message: 'Ya conectado' });
  }

  if (!qr) {
    return res.json({ status: 'waiting', message: 'Esperando QR...' });
  }

  try {
    const qrImage = await QRCode.toDataURL(qr, { width: 300 });
    res.json({ status: 'qr_ready', qr: qrImage, raw: qr });
  } catch (err) {
    res.json({ status: 'qr_ready', qr: null, raw: qr });
  }
});

// ============================================
// 3. LISTA DE CHATS
// ============================================
router.get('/chats', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const chats = await getChats(limit);

    const enriched = chats.map(chat => ({
      ...chat,
      name: getContactName(chat.jid) || chat.name || chat.phone
    }));

    res.json({
      chats: enriched,
      total: enriched.length,
      source: 'supabase'
    });
  } catch (err) {
    console.error('Error /chats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 4. MENSAJES DE UN CHAT
// ============================================
router.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null;

    const messages = await getMessages(chatId, limit, before);

    res.json({
      messages,
      chatId,
      total: messages.length
    });
  } catch (err) {
    console.error('Error /messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 5. FOTO DE PERFIL
// ============================================
router.get('/chats/:chatId/photo', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const url = await getProfilePhoto(chatId);
    res.json({ photo: url, source: url ? 'whatsapp' : 'unavailable' });
  } catch {
    res.json({ photo: null, source: 'error' });
  }
});

// ============================================
// 6. SSE - EVENTOS TIEMPO REAL
// ============================================
router.get('/events', (req, res) => {
  const sse = req.app.get('sse');
  if (!sse) {
    return res.status(500).json({ error: 'SSE no disponible' });
  }
  sse.addClient(req, res);
});

// ============================================
// 7. ENVIAR MENSAJE
// ============================================
router.post('/send', async (req, res) => {
  try {
    const { chatId, message, type = 'text' } = req.body;

    if (!chatId || !message) {
      return res.status(400).json({ error: 'chatId y message son requeridos' });
    }

    let content;
    if (type === 'text') {
      content = message;
    } else if (type === 'image') {
      content = { image: { url: message.url }, caption: message.caption };
    } else if (type === 'document') {
      content = { document: { url: message.url }, fileName: message.fileName };
    } else {
      content = message;
    }

    const result = await sendMessage(chatId, content);
    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    console.error('Error /send:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 8. DESCONECTAR
// ============================================
router.post('/disconnect', async (req, res) => {
  try {
    await disconnect();
    res.json({ success: true, message: 'Desconectado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 9. SETTINGS
// ============================================
router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server',
    version: '1.0.0',
    engine: 'baileys-standalone',
    connection: getConnectionState(),
    sse: req.app.get('sse')?.getStatus(),
    supabase: !!req.app.get('supabase'),
    uptime: Math.floor(process.uptime()),
    contacts: contactCache.keys().length
  });
});

// ============================================
// 10. CONTACTOS
// ============================================
router.get('/contacts', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.json({ clients: [] });

    const { data, error } = await supabase
      .from('oasis_wa_chats')
      .select('*')
      .order('last_timestamp', { ascending: false });

    if (error) throw error;

    const enriched = (data || []).map(c => ({
      ...c,
      live_name: getContactName(c.jid) || c.name || c.phone
    }));

    res.json({ clients: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
