import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { Server } from 'socket.io';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { Game } from './game.js';
import type { Command, Result } from '../shared/types.js';

export async function buildApp(options: {
  file: string;
  staticDir?: string;
  port?: number;
  quiet?: boolean;
}) {
  const game = new Game(options.file);
  const app = Fastify({ logger: !options.quiet, bodyLimit: 4096 });
  const io = new Server(app.server, {
    maxHttpBufferSize: 4096,
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(
        null,
        !origin ||
          origin === 'http://' + req.headers.host ||
          origin === 'https://' + req.headers.host,
      );
    },
  });
  const attempts = new Map<string, { count: number; until: number }>();
  const host = (value: unknown) => typeof value === 'string' && value === game.state.hostKey;
  const bearer = (value?: string) => (value?.startsWith('Bearer ') ? value.slice(7) : '');
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (
      req.headers.origin &&
      req.headers.origin !== 'http://' + req.headers.host &&
      req.headers.origin !== 'https://' + req.headers.host
    )
      return reply.code(403).send({ error: 'Запрос с другого сайта запрещён' });
  });
  app.post<{ Body: { code?: unknown; invitation?: unknown; token?: unknown } }>(
    '/api/login',
    async (req, reply) => {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
      const limit = attempts.get(req.ip) ?? { count: 0, until: now + 60000 };
      limit.count++;
      attempts.set(req.ip, limit);
      if (limit.count > 12)
        return reply.code(429).send({ error: 'Слишком много попыток. Подождите минуту.' });
      if (typeof req.body?.code !== 'string' && typeof req.body?.invitation !== 'string')
        return reply.code(400).send({ error: 'Введите код игрока' });
      try {
        const session =
          typeof req.body.invitation === 'string'
            ? game.loginInvitation(
                req.body.invitation,
                typeof req.body.token === 'string' ? req.body.token : undefined,
              )
            : game.login(req.body.code as string);
        broadcast();
        return { token: session.token };
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message === 'Неверный код игрока' || e.message.startsWith('Ссылка недействительна.'))
        )
          return reply.code(401).send({ error: e.message });
        app.log.error(e);
        return reply.code(500).send({ error: 'Не удалось сохранить вход. Проверьте сервер.' });
      }
    },
  );
  app.get('/api/health', async () => ({ ok: true }));
  app.get<{ Params: { code: string } }>('/h/:code', async (req, reply) => {
    if (req.params.code.toUpperCase() !== game.state.hostCode)
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('Неверный код ведущего. Проверьте ссылку на ноутбуке.');
    return reply.redirect('/host#' + game.state.hostKey);
  });
  app.get('/api/host-info', async (req, reply) => {
    if (!host(bearer(req.headers.authorization)))
      return reply.code(401).send({ error: 'Нет доступа' });
    const port = options.port ?? (app.server.address() as { port: number })?.port ?? 3000;
    const interfaces = Object.entries(networkInterfaces()).flatMap(([name, values]) =>
      (values ?? [])
        .filter((v) => !v.internal && v.family === 'IPv4')
        .map((v) => ({ name, ip: v.address })),
    );
    const virtual =
      /(vethernet|virtual|vmware|wsl|docker|loopback|bluetooth|tailscale|zerotier|vpn|xray|tun|tap)/i;
    interfaces.sort((a, b) => Number(virtual.test(a.name)) - Number(virtual.test(b.name)));
    const ips = interfaces.map((v) => v.ip);
    const addresses = [...new Set(ips)].map((ip) => ({ url: 'http://' + ip + ':' + port }));
    return { addresses, hostPath: '/h/' + game.state.hostCode };
  });
  const online = () =>
    new Set(
      [...io.sockets.sockets.values()]
        .filter((s) => s.data.role === 'player' && game.playerByToken(s.data.token))
        .map((s) => game.playerByToken(s.data.token)!.id),
    );
  function broadcast() {
    const connected = online();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role === 'player' && !game.playerByToken(socket.data.token)) {
        socket.emit('revoked');
        socket.disconnect(true);
        continue;
      }
      socket.emit('state', game.view(socket.data.role, socket.data.token, connected));
    }
  }
  const blindTicker = setInterval(() => {
    try {
      if (game.tick()) broadcast();
    } catch (error) {
      app.log.error(error, 'Не удалось сохранить повышение блайндов');
    }
  }, 250);
  blindTicker.unref();
  app.addHook('onClose', async () => {
    clearInterval(blindTicker);
  });
  io.use((socket, next) => {
    const { role, token } = socket.handshake.auth ?? {};
    if (
      typeof token !== 'string' ||
      !((role === 'host' && host(token)) || (role === 'player' && game.playerByToken(token)))
    )
      return next(new Error('AUTH'));
    socket.data = { role, token };
    next();
  });
  io.on('connection', (socket) => {
    broadcast();
    socket.on('fold', (hand: number, ack: (result: Result) => void) => {
      if (typeof ack !== 'function') return;
      if (socket.data.role !== 'player') return ack({ ok: false, error: 'Действие игрока' });
      try {
        game.fold(socket.data.token, hand);
        broadcast();
        ack({ ok: true });
      } catch (e) {
        ack({ ok: false, error: e instanceof Error ? e.message : 'Ошибка' });
      }
    });
    socket.on('showCards', (hand: number, ack: (result: Result) => void) => {
      if (typeof ack !== 'function') return;
      if (socket.data.role !== 'player') return ack({ ok: false, error: 'Карты открывает игрок' });
      try {
        game.showCards(socket.data.token, hand);
        broadcast();
        ack({ ok: true });
      } catch (e) {
        ack({ ok: false, error: e instanceof Error ? e.message : 'Не удалось открыть карты' });
      }
    });
    socket.on('command', (cmd: Command, ack: (result: Result) => void) => {
      if (typeof ack !== 'function') return;
      if (socket.data.role !== 'host' || !host(socket.data.token))
        return ack({ ok: false, error: 'Действие доступно только ведущему' });
      try {
        if (game.tick()) broadcast();
        const result = game.command(cmd);
        broadcast();
        ack(result);
      } catch (e) {
        ack({ ok: false, error: e instanceof Error ? e.message : 'Не удалось выполнить действие' });
      }
    });
    socket.on('disconnect', () => broadcast());
  });
  if (options.staticDir) {
    await app.register(staticFiles, { root: resolve(options.staticDir) });
    app.get('/host', async (_req, reply) => reply.sendFile('index.html'));
  }
  await app.ready();
  return {
    app,
    io,
    game,
    close: async () => {
      clearInterval(blindTicker);
      await new Promise<void>((r) => io.close(() => r()));
      await app.close();
    },
  };
}
