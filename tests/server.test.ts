import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { buildApp } from '../server/app';
import type { TableView, Result } from '../shared/types';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function setup() {
  mkdirSync('work', { recursive: true });
  const instance = await buildApp({
    file: resolve(mkdtempSync(resolve('work/test-server-')), 'table.json'),
    staticDir: resolve('dist'),
    quiet: true,
  });
  await instance.app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(() => instance.close());
  const address = instance.app.server.address() as { port: number };
  return { ...instance, url: 'http://127.0.0.1:' + address.port };
}
function nextState(s: Socket): Promise<TableView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No state')), 3000);
    s.once('state', (v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}
async function connect(url: string, role: string, token: string) {
  const s = io(url, { auth: { role, token }, autoConnect: false, reconnection: false });
  cleanup.push(() => {
    s.disconnect();
  });
  const ready = nextState(s);
  s.connect();
  return { socket: s, state: await ready };
}
function send(s: Socket, data: unknown): Promise<Result> {
  return new Promise((resolve, reject) =>
    s
      .timeout(3000)
      .emit('command', data, (e: Error | null, v: Result) => (e ? reject(e) : resolve(v))),
  );
}
describe('Server boundaries', () => {
  it('serves the app without exposing state files or host metadata', async () => {
    const x = await setup();
    expect((await x.app.inject('/')).statusCode).toBe(200);
    expect((await x.app.inject('/host')).statusCode).toBe(200);
    expect((await x.app.inject('/data/table.json')).statusCode).toBe(404);
    expect((await x.app.inject('/api/host-info')).statusCode).toBe(401);
    expect((await x.app.inject('/api/health')).json()).toEqual({ ok: true });
  });
  it('rejects invalid credentials and foreign origins', async () => {
    const x = await setup();
    const r = await x.app.inject({ method: 'POST', url: '/api/login', payload: { code: 'WRONG' } });
    expect(r.statusCode).toBe(401);
    expect(
      (
        await x.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin: 'https://foreign.invalid' },
          payload: { code: 'WRONG' },
        })
      ).statusCode,
    ).toBe(403);
    const s = io(x.url, {
      auth: { role: 'host', token: 'bad' },
      autoConnect: false,
      reconnection: false,
    });
    cleanup.push(() => {
      s.disconnect();
    });
    const error = new Promise<string>((r) => s.once('connect_error', (e) => r(e.message)));
    s.connect();
    expect(await error).toBe('AUTH');
  });
  it('rate limits code guessing', async () => {
    const x = await setup();
    for (let i = 0; i < 12; i++)
      await x.app.inject({ method: 'POST', url: '/api/login', payload: { code: 'WRONG' } });
    expect(
      (await x.app.inject({ method: 'POST', url: '/api/login', payload: { code: 'WRONG' } }))
        .statusCode,
    ).toBe(429);
  });
  it('streams private views, rejects player commands and restores a disconnected hand', async () => {
    const x = await setup(),
      host = await connect(x.url, 'host', x.game.state.hostKey);
    let r = await send(host.socket, {
      action: 'add',
      revision: x.game.state.revision,
      name: 'Alice',
    });
    const code = r.code!;
    await send(host.socket, { action: 'add', revision: x.game.state.revision, name: 'Bob' });
    const login = await x.app.inject({ method: 'POST', url: '/api/login', payload: { code } }),
      token = login.json().token;
    const p = await connect(x.url, 'player', token);
    expect((await send(p.socket, { action: 'deal', revision: x.game.state.revision })).ok).toBe(
      false,
    );
    const updated = nextState(p.socket);
    await send(host.socket, { action: 'deal', revision: x.game.state.revision });
    const dealt = await updated;
    expect(dealt.cards).toHaveLength(2);
    expect(dealt.board).toHaveLength(0);
    expect(dealt.players.every((p) => !('cards' in p))).toBe(true);
    p.socket.disconnect();
    const restored = await connect(x.url, 'player', token);
    expect(restored.state.cards).toEqual(dealt.cards);
    const revoked = new Promise<void>((r) => restored.socket.once('revoked', () => r()));
    const again = await x.app.inject({ method: 'POST', url: '/api/login', payload: { code } });
    await revoked;
    const replacement = await connect(x.url, 'player', again.json().token);
    expect(replacement.state.cards).toEqual(dealt.cards);
    const future = nextState(replacement.socket);
    await send(host.socket, { action: 'advance', revision: x.game.state.revision });
    expect((await future).board).toHaveLength(3);
  });
});

describe('Invitation transport', () => {
  it('allows only the host to obtain a link and redeems it through HTTP', async () => {
    const x = await setup(),
      host = await connect(x.url, 'host', x.game.state.hostKey);
    const added = await send(host.socket, {
      action: 'add',
      name: 'Link player',
      revision: x.game.state.revision,
    });
    const login = await x.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { invitation: added.invitation },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;
    const player = await connect(x.url, 'player', token);
    expect(player.state.selfId).toBe(added.playerId);
    expect(
      (
        await send(player.socket, {
          action: 'invite',
          playerId: added.playerId,
          revision: x.game.state.revision,
        })
      ).ok,
    ).toBe(false);
    const before = x.game.state.revision;
    const link = await send(host.socket, {
      action: 'invite',
      playerId: added.playerId,
      revision: before,
    });
    expect(link.invitation).toBe(added.invitation);
    expect(x.game.state.revision).toBe(before);
    const reuse = await x.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { invitation: link.invitation, token },
    });
    expect(reuse.json().token).toBe(token);
    expect(x.game.state.revision).toBe(before);
    const revoked = new Promise<void>((r) => player.socket.once('revoked', () => r()));
    await send(host.socket, {
      action: 'recode',
      playerId: added.playerId,
      revision: x.game.state.revision,
    });
    await revoked;
    expect(
      (
        await x.app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { invitation: link.invitation },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('Multiple host devices', () => {
  it('broadcasts automatic blind changes to hosts and players and rejects player timer controls', async () => {
    const x = await setup();
    const host = await connect(x.url, 'host', x.game.state.hostKey);
    const added = await send(host.socket, {
      action: 'add',
      name: 'Clock player',
      revision: x.game.state.revision,
    });
    const login = await x.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { code: added.code },
    });
    const player = await connect(x.url, 'player', login.json().token);
    for (const action of [
      'blindStart',
      'blindPause',
      'blindNext',
      'blindPrevious',
      'blindReset',
      'blindSettings',
      'blindPresetSave',
      'blindRemove',
    ]) {
      expect((await send(player.socket, { action, revision: x.game.state.revision })).ok).toBe(
        false,
      );
    }
    const started = nextState(player.socket);
    expect(
      (await send(host.socket, { action: 'blindStart', revision: x.game.state.revision })).ok,
    ).toBe(true);
    expect((await started).blinds.running).toBe(true);
    const hostLevel = nextState(host.socket);
    const playerLevel = nextState(player.socket);
    x.game.state.blinds.endsAt = Date.now() - 1;
    const [hostView, playerView] = await Promise.all([hostLevel, playerLevel]);
    expect(hostView.blinds.level).toBe(1);
    expect(playerView.blinds).toEqual(hostView.blinds);
    expect(playerView.revision).toBe(hostView.revision);
    expect(playerView.blinds.running).toBe(false);
    expect(playerView.blinds.awaitingDeal).toBe(true);
    expect(
      (await send(host.socket, { action: 'blindStart', revision: x.game.state.revision })).ok,
    ).toBe(false);
  });
  it('accepts commands from both hosts and broadcasts the same table', async () => {
    const x = await setup();
    const laptop = await connect(x.url, 'host', x.game.state.hostKey);
    const tablet = await connect(x.url, 'host', x.game.state.hostKey);
    const laptopUpdate = nextState(laptop.socket);
    expect(
      (
        await send(tablet.socket, {
          action: 'add',
          name: 'Tablet player',
          revision: tablet.state.revision,
        })
      ).ok,
    ).toBe(true);
    const current = await laptopUpdate;
    expect(current.players.map((p) => p.name)).toEqual(['Tablet player']);
    const tabletUpdate = nextState(tablet.socket);
    expect(
      (
        await send(laptop.socket, {
          action: 'add',
          name: 'Laptop player',
          revision: current.revision,
        })
      ).ok,
    ).toBe(true);
    const updated = await tabletUpdate;
    expect(updated.players.map((p) => p.name)).toEqual(['Tablet player', 'Laptop player']);
    expect(updated.role).toBe('host');
    expect(updated.cards).toBeUndefined();
    expect((await send(tablet.socket, { action: 'deal', revision: current.revision })).ok).toBe(
      false,
    );
    expect(x.game.state.stage).toBe('waiting');
  });
});

describe('Short host link', () => {
  it('opens the host from a five-character code, ignores case and keeps the code after restart', async () => {
    const x = await setup();
    const code = x.game.state.hostCode!;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const info = await x.app.inject({
      url: '/api/host-info',
      headers: { authorization: 'Bearer ' + x.game.state.hostKey },
    });
    expect(info.json().hostPath).toBe('/h/' + code);
    for (const value of [code, code.toLowerCase()]) {
      const response = await x.app.inject('/h/' + value);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/host#' + x.game.state.hostKey);
    }
    expect((await x.app.inject('/h/00000')).statusCode).toBe(404);
    const { Game } = await import('../server/game');
    expect(new Game(x.game.file).state.hostCode).toBe(code);
    x.game.command({ action: 'newGame', revision: x.game.state.revision });
    expect(x.game.state.hostCode).toBe(code);
    const { writeFileSync } = await import('node:fs');
    const legacy = { ...x.game.state };
    delete legacy.hostCode;
    writeFileSync(x.game.file, JSON.stringify(legacy));
    const migrated = new Game(x.game.file);
    expect(migrated.state.hostCode).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(migrated.state.hostKey).toBe(legacy.hostKey);
    expect(new Game(x.game.file).state.hostCode).toBe(migrated.state.hostCode);
  });
});
