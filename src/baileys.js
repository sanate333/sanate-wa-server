/**
 * BAILEYS - Conexion directa con WhatsApp
 *
 * Al conectar (QR escaneado), automaticamente:
 * 1. Carga los ultimos 15 chats
 * 2. De cada chat, guarda los ultimos 20 mensajes
 * 3. Guarda todo en Supabase (oasis_wa_chats + oasis_wa_messages)
 * 4. Escucha nuevos mensajes y los guarda + emite por SSE
 * 5. Si se desconecta, reconecta automaticamente
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
  isJidBroadcast
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');

const {
  saveMessage,
  upsertChat,
  syncInitialChats
} = require('./supabase');

// === ESTADO GLOBAL ===
let sock = null;
let qrCode = null;
let connectionState = 'disconnected';
let sseManager = null;
let supabaseClient = null;
let initialSyncDone = false;

// Cache para fotos de perfil (15 min) y contactos (1 hora)
const photoCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });
const contactCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// === GETTERS ===
function getSocket() { return sock; }
function getQR() { return qrCode; }
function getConnectionState() { return connectionState; }

// === INICIALIZAR ===
async function initBaileys(supabase, sse) {
  supabaseClient = supabase;
  sseManager = sse;

  const authDir = path.join(__dirname, '..', 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  await connectToWhatsApp();
}

// === CONEXION PRINCIPAL ===
async function connectToWhatsApp() {
  const authDir = path.join(__dirname, '..', 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      return { conversation: '' };
    }
  });

  // === GUARDAR CREDENCIALES ===
  sock.ev.on('creds.update', saveCreds);

  // === ESTADO DE CONEXION ===
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionState = 'qr_ready';
      console.log('QR listo - escanea con tu telefono');
      sseManager?.broadcast({ type: 'qr', data: { qr } });
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('Desconectado. Razon: ' + reason);

      sseManager?.broadcast({
        type: 'connection',
        data: { status: 'disconnected', reason }
      });

      if (reason !== DisconnectReason.loggedOut) {
        console.log('Reconectando en 5 segundos...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('Logout. Borrando sesion...');
        const authDir = path.join(__dirname, '..', 'auth_info');
        fs.rmSync(authDir, { recursive: true, force: true });
        fs.mkdirSync(authDir, { recursive: true });
        qrCode = null;
        initialSyncDone = false;
      }
    }

    if (connection === 'open') {
      connectionState = 'connected';
      qrCode = null;
      console.log('WhatsApp CONECTADO');

      sseManager?.broadcast({
        type: 'connection',
        data: { status: 'connected' }
      });

      if (!initialSyncDone) {
        setTimeout(() => runInitialSync(), 3000);
      }
    }
  });

  // ===================================================
  // MENSAJES NUEVOS - El corazon del bot
  // ===================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const chatId = msg.key.remoteJid;
      const fromMe = msg.key.fromMe || false;
      const isGroup = isJidGroup(chatId);
      const pushName = msg.pushName || null;
      const senderName = pushName || contactCache.get(chatId) || chatId.split('@')[0];
      const messageText = extractText(msg);
      const messageType = getMessageType(msg);
      const timestamp = msg.messageTimestamp;

      if (pushName && !isGroup) {
        contactCache.set(chatId, pushName);
      }

      console.log((fromMe ? '-> ' : '<- ') + senderName + ': ' + (messageText?.substring(0, 60) || '[' + messageType + ']'));

      // 1. Guardar mensaje en Supabase
      await saveMessage(chatId, senderName, {
        messageId: msg.key.id,
        text: messageText,
        type: messageType,
        fromMe,
        timestamp: timestamp
          ? (typeof timestamp === 'object' ? timestamp.low || timestamp : timestamp)
          : Math.floor(Date.now() / 1000)
      });

      // 2. Actualizar chat en Supabase
      await upsertChat(
        chatId,
        senderName,
        messageText || ('[' + messageType + ']'),
        typeof timestamp === 'object' ? timestamp.low || timestamp : timestamp
      );

      // 3. Emitir SSE para el dashboard (TIEMPO REAL)
      sseManager?.broadcast({
        type: 'message',
        data: {
          chatId,
          messageId: msg.key.id,
          pushName: senderName,
          text: messageText,
          messageType,
          fromMe,
          isGroup,
          timestamp: Date.now()
        }
      });
    }
  });

  // === CONTACTOS ACTUALIZADOS ===
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (u.notify) {
        contactCache.set(u.id, u.notify);
      }
    }
  });

  // === PRESENCIA ===
  sock.ev.on('presence.update', (update) => {
    sseManager?.broadcast({ type: 'presence', data: update });
  });
}

// ===================================================
// SYNC INICIAL - Ultimos 15 chats, 20 msgs c/u
// ===================================================
async function runInitialSync() {
  if (initialSyncDone) return;
  if (!sock || connectionState !== 'connected') return;

  console.log('');
  console.log('SYNC INICIAL: Ultimos 15 chats');
  console.log('===============================');

  sseManager?.broadcast({
    type: 'sync_start',
    data: { message: 'Sincronizando ultimos 15 chats...' }
  });

  try {
    const chats = await sock.groupFetchAllParticipating().catch(() => ({}));

    console.log('Esperando history sync de Baileys...');

    let syncedChats = new Map();
    let syncTimeout = null;

    const historySyncHandler = async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || !msg.key.remoteJid) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (isJidBroadcast(msg.key.remoteJid)) continue;

        const chatId = msg.key.remoteJid;

        if (!syncedChats.has(chatId)) {
          syncedChats.set(chatId, {
            jid: chatId,
            name: msg.pushName || contactCache.get(chatId) || chatId.split('@')[0],
            lastMessage: extractText(msg) || '[media]',
            lastTimestamp: msg.messageTimestamp,
            messages: []
          });

          if (msg.pushName) {
            contactCache.set(chatId, msg.pushName);
          }
        }

        const chatData = syncedChats.get(chatId);

        if (chatData.messages.length < 20) {
          chatData.messages.push({
            messageId: msg.key.id,
            text: extractText(msg),
            type: getMessageType(msg),
            fromMe: msg.key.fromMe || false,
            timestamp: msg.messageTimestamp
          });
        }

        if (syncedChats.size >= 15) {
          clearTimeout(syncTimeout);
          finishSync();
          return;
        }
      }

      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(finishSync, 8000);
    };

    async function finishSync() {
      sock.ev.off('messages.upsert', historySyncHandler);

      if (syncedChats.size === 0) {
        console.log('No se recibio historial. Los chats se sincronizaran cuando lleguen mensajes.');
        initialSyncDone = true;
        sseManager?.broadcast({
          type: 'sync_complete',
          data: { synced: 0, message: 'Sin historial previo. Chats se sincronizan en tiempo real.' }
        });
        return;
      }

      const chatsArray = Array.from(syncedChats.values())
        .sort((a, b) => {
          const tsA = typeof a.lastTimestamp === 'object' ? (a.lastTimestamp.low || 0) : (a.lastTimestamp || 0);
          const tsB = typeof b.lastTimestamp === 'object' ? (b.lastTimestamp.low || 0) : (b.lastTimestamp || 0);
          return tsB - tsA;
        })
        .slice(0, 15);

      const result = await syncInitialChats(chatsArray);
      initialSyncDone = true;

      console.log('');
      console.log('SYNC COMPLETO: ' + result.synced + ' chats guardados en Supabase');
      console.log('');

      sseManager?.broadcast({
        type: 'sync_complete',
        data: {
          synced: result.synced,
          errors: result.errors,
          chats: chatsArray.map(c => ({ jid: c.jid, name: c.name, msgs: c.messages.length }))
        }
      });
    }

    sock.ev.on('messages.upsert', historySyncHandler);
    syncTimeout = setTimeout(finishSync, 30000);

  } catch (err) {
    console.error('Error en sync inicial:', err.message);
    initialSyncDone = true;
  }
}

// ===================================================
// FUNCIONES AUXILIARES
// ===================================================

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;

  const inner = m.ephemeralMessage?.message
    || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message
    || m;

  return inner.conversation
    || inner.extendedTextMessage?.text
    || inner.imageMessage?.caption
    || inner.videoMessage?.caption
    || inner.documentMessage?.caption
    || inner.buttonsResponseMessage?.selectedDisplayText
    || inner.listResponseMessage?.title
    || inner.templateButtonReplyMessage?.selectedDisplayText
    || null;
}

function getMessageType(msg) {
  const m = msg.message;
  if (!m) return 'unknown';

  const inner = m.ephemeralMessage?.message
    || m.viewOnceMessage?.message
    || m;

  if (inner.conversation || inner.extendedTextMessage) return 'text';
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage) return 'video';
  if (inner.audioMessage) return 'audio';
  if (inner.documentMessage) return 'document';
  if (inner.stickerMessage) return 'sticker';
  if (inner.contactMessage || inner.contactsArrayMessage) return 'contact';
  if (inner.locationMessage || inner.liveLocationMessage) return 'location';
  return 'other';
}

// === FOTO DE PERFIL ===
async function getProfilePhoto(jid) {
  const cached = photoCache.get(jid);
  if (cached !== undefined) return cached;

  try {
    if (!sock || connectionState !== 'connected') return null;
    const url = await sock.profilePictureUrl(jid, 'image');
    photoCache.set(jid, url || null);
    return url || null;
  } catch {
    photoCache.set(jid, null);
    return null;
  }
}

// === NOMBRE DE CONTACTO ===
function getContactName(jid) {
  return contactCache.get(jid) || null;
}

// === ENVIAR MENSAJE ===
async function sendMessage(chatId, content) {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp no esta conectado');
  }

  const messagePayload = typeof content === 'string'
    ? { text: content }
    : content;

  const sent = await sock.sendMessage(chatId, messagePayload);
  const sentText = typeof content === 'string' ? content : content.text || '[media]';

  await saveMessage(chatId, 'Sanate Bot', {
    messageId: sent.key.id,
    text: sentText,
    type: 'text',
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000)
  });

  await upsertChat(chatId, null, sentText, Math.floor(Date.now() / 1000));

  sseManager?.broadcast({
    type: 'message_sent',
    data: {
      chatId,
      messageId: sent.key.id,
      text: sentText,
      timestamp: Date.now()
    }
  });

  return sent;
}

// === DESCONECTAR ===
async function disconnect() {
  if (sock) {
    await sock.logout();
    sock = null;
    connectionState = 'disconnected';
    initialSyncDone = false;
  }
}

module.exports = {
  initBaileys,
  getSocket,
  getQR,
  getConnectionState,
  getProfilePhoto,
  getContactName,
  sendMessage,
  disconnect,
  contactCache,
  photoCache
};
