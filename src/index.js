/**
 * SANATE WhatsApp Bot Server
 * Reemplazo completo de n8n + Baileys standalone
 *
 * Este servidor hace TODO lo que hacía n8n:
 * 1. Mantiene conexión con WhatsApp via Baileys
 * 2. Recibe y envía mensajes
 * 3. Guarda datos en Supabase
 * 4. Emite eventos SSE en tiempo real
 * 5. Resuelve fotos de perfil y nombres de contacto
 * 6. Sirve API REST para el dashboard
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');

const { initBaileys, getSocket, getQR, getConnectionState } = require('./baileys');
const { initSupabase } = require('./supabase');
const { SSEManager } = require('./sse');
const apiRoutes = require('./routes');

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5055;

// === MIDDLEWARE ===
app.use(cors({
  origin: ['https://sanate.store', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// === SSE MANAGER (tiempo real) ===
const sse = new SSEManager();
app.set('sse', sse);

// === HEALTH CHECK (Render lo necesita) ===
app.get('/', (req, res) => {
  res.json({
    service: 'Sanate WhatsApp Bot',
    status: 'running',
    uptime: Math.floor(process.uptime()),
    connection: getConnectionState(),
    timestamp: new Date().toISOString()
  });
});

// === API ROUTES ===
app.use('/api/whatsapp', apiRoutes);

// === ARRANCAR TODO ===
async function start() {
  console.log('\u{1F33F} Sanate WhatsApp Bot Server');
  console.log('================================');

  // 1. Conectar Supabase
  console.log('\u{1F4BE} Conectando Supabase...');
  const supabase = initSupabase();
  app.set('supabase', supabase);
  console.log('\u2705 Supabase conectado');

  // 2. Iniciar servidor HTTP
  server.listen(PORT, () => {
    console.log(`\u{1F680} Servidor corriendo en puerto ${PORT}`);
    console.log(`\u{1F4E1} SSE disponible en /api/whatsapp/events`);
  });

  // 3. Iniciar Baileys (conexión WhatsApp)
  console.log('\u{1F4F1} Iniciando conexión WhatsApp...');
  await initBaileys(supabase, sse);
  console.log('\u2705 Baileys iniciado');
}

start().catch(err => {
  console.error('\u274C Error fatal:', err);
  process.exit(1);
});
