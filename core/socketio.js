'use strict';
const { Server } = require('socket.io');
const { buildGateway } = require('./gateway');

function socketAuthMiddleware(auth) {
  return function authorize(socket, next) {
    try {
      const handshake = (socket && socket.handshake) || {};
      const handshakeAuth = (handshake.auth && typeof handshake.auth === 'object' ? handshake.auth : {}) || {};
      const token = handshakeAuth.token;
      const result = auth.authenticateToken(token);
      socket.data = socket.data || {};
      socket.data.session = result.session;
      socket.data.user = result.user;
      socket.data.resumeToken =
        typeof handshakeAuth.resumeToken === 'string' ? handshakeAuth.resumeToken : null;
      return next();
    } catch (err) {
      return next(new Error(err && err.code ? err.code : 'E_AUTH'));
    }
  };
}

function createServer(httpServer, socketIoOptions) {
  if (httpServer instanceof Server) return httpServer;
  return new Server(httpServer, {
    path: '/socket.io',
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1000000,
    ...(socketIoOptions || {}),
  });
}

function buildSocketIo(input) {
  const dataLayer = input && input.dataLayer;
  const httpServer = input && input.httpServer;
  const options = (input && input.options) || {};
  if (!dataLayer) {
    throw new Error('buildSocketIo requires a dataLayer');
  }
  const io = httpServer instanceof Server ? httpServer : createServer(httpServer, options.socketIo);
  const gateway =
    input && input.gateway
      ? input.gateway
      : buildGateway({
          db: dataLayer.db,
          repos: dataLayer,
          auth: dataLayer.auth,
          options: options.gateway,
        });
  io.use(socketAuthMiddleware(dataLayer.auth));
  const community = dataLayer.community || null;
  const gatewayOptions = options.gateway || {};
  if (gatewayOptions.sweepIntervalMs !== 0) {
    gateway.startSweep(gatewayOptions.sweepIntervalMs);
  }
  io.on('connection', (socket) => {
    const handshakeAuth =
      socket.handshake && socket.handshake.auth && typeof socket.handshake.auth === 'object'
        ? socket.handshake.auth
        : {};
    const id = socket.id;
    const sock = {
      id,
      token: typeof handshakeAuth.token === 'string' ? handshakeAuth.token : '',
      resumeToken: typeof handshakeAuth.resumeToken === 'string' ? handshakeAuth.resumeToken : null,
      ip: (socket.handshake && socket.handshake.address) || null,
      userAgent:
        (socket.handshake &&
          socket.handshake.headers &&
          socket.handshake.headers['user-agent']) ||
        null,
      emit(event, payload) {
        socket.emit(event, payload);
      },
      on(event, handler) {
        socket.on(event, handler);
      },
      disconnect(close) {
        try {
          socket.disconnect(close);
        } catch (_) {
          // socket already gone
        }
      },
    };
    gateway.handleConnection(sock);
    socket.on('disconnect', () => {
      gateway.handleDisconnect(id);
    });

    if (community) {
      const userId = socket.data && socket.data.user ? socket.data.user.id : null;
      const userRole = socket.data && socket.data.user ? socket.data.user.role : null;
      if (userRole === 'admin' || userRole === 'support') socket.join('support:staff');
      socket.on('chat:join', (payload = {}) => {
        try {
          const group = String(payload.group || '').trim().toLowerCase();
          const messages = community.listChatMessages(userId, group, 80);
          socket.join('chat:' + group);
          socket.emit('chat:joined', {
            group: community.listGroups().find((g) => g.group_key === group) || { group_key: group },
            messages,
          });
        } catch (err) {
          socket.emit('error', { code: err.code || 'E_CHAT_GROUP_INVALID', message: err.message || 'chat join failed' });
        }
      });

      socket.on('chat:send', (payload = {}) => {
        try {
          const group = String(payload.group || '').trim().toLowerCase();
          const clientRef = String(payload.client_ref || (socket.id + '-' + Date.now()));
          const result = community.sendChatMessage({
            user_id: userId,
            group_key: group,
            body: payload.body,
            idempotency_key: clientRef,
          });
          io.to('chat:' + group).emit('chat:message', result.message);
        } catch (err) {
          socket.emit('error', { code: err.code || 'E_CHAT_MESSAGE', message: err.message || 'chat message failed' });
        }
      });

      socket.on('support:join', (payload = {}) => {
        try {
          const ticketId = String(payload.ticketId || '');
          const ticket = community.getTicket(userId, ticketId);
          const messages = community.listTicketMessages(userId, ticketId, 200);
          socket.join('support:' + ticketId);
          socket.emit('support:joined', { ticket, messages });
        } catch (err) {
          socket.emit('error', { code: err.code || 'E_SUPPORT_TICKET_NOT_FOUND', message: err.message || 'support join failed' });
        }
      });

      socket.on('support:message', (payload = {}) => {
        try {
          const ticketId = String(payload.ticketId || '');
          const clientRef = String(payload.client_ref || (socket.id + '-' + Date.now()));
          const result = community.addTicketMessage({
            user_id: userId,
            ticket_id: ticketId,
            body: payload.body,
            idempotency_key: clientRef,
          });
          io.to('support:' + ticketId).emit('support:message', result.message);
        } catch (err) {
          socket.emit('error', { code: err.code || 'E_SUPPORT_MESSAGE', message: err.message || 'support message failed' });
        }
      });

      socket.on('support:status', (payload = {}) => {
        try {
          const ticketId = String(payload.ticketId || '');
          const ticket = community.setTicketStatus(userId, ticketId, String(payload.status || ''));
          io.to('support:' + ticketId).emit('support:updated', { ticket });
        } catch (err) {
          socket.emit('error', { code: err.code || 'E_FORBIDDEN', message: err.message || 'support status failed' });
        }
      });
    }
  });
  return { io, gateway };
}

module.exports = {
  socketAuthMiddleware,
  createServer,
  buildSocketIo,
};