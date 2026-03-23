/**
 * SSE MANAGER - Eventos en Tiempo Real
 *
 * SSE (Server-Sent Events) permite que el dashboard reciba
 * mensajes instantáneamente sin recargar la página.
 *
 * Cada vez que llega un mensaje a WhatsApp, se emite un evento
 * a TODOS los clientes conectados (pestañas del dashboard abiertas).
 */

class SSEManager {
  constructor() {
    this.clients = new Map();
    this.clientId = 0;

    // Heartbeat cada 25 segundos para mantener conexión viva
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: 'heartbeat', data: { time: Date.now() } });
    }, 25000);

    console.log('SSE Manager iniciado');
  }

  addClient(req, res) {
    const id = ++this.clientId;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId: id })}\n\n`);

    this.clients.set(id, res);
    console.log(`SSE cliente #${id} conectado (total: ${this.clients.size})`);

    req.on('close', () => {
      this.clients.delete(id);
      console.log(`SSE cliente #${id} desconectado (total: ${this.clients.size})`);
    });

    return id;
  }

  broadcast(event) {
    const data = JSON.stringify(event);
    const message = `data: ${data}\n\n`;

    let sent = 0;
    for (const [id, res] of this.clients) {
      try {
        res.write(message);
        sent++;
      } catch (err) {
        this.clients.delete(id);
      }
    }

    if (event.type === 'message') {
      console.log(`SSE broadcast mensaje a ${sent} clientes`);
    }
  }

  sendTo(clientId, event) {
    const res = this.clients.get(clientId);
    if (res) {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        return true;
      } catch {
        this.clients.delete(clientId);
      }
    }
    return false;
  }

  getStatus() {
    return {
      clients: this.clients.size,
      uptime: Math.floor(process.uptime())
    };
  }

  destroy() {
    clearInterval(this.heartbeatInterval);
    for (const [id, res] of this.clients) {
      try { res.end(); } catch {}
    }
    this.clients.clear();
  }
}

module.exports = { SSEManager };
