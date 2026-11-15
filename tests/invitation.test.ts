import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../server/game';
import { invitationLink } from '../src/invitation';

function setup() {
  mkdirSync('work', { recursive: true });
  const game = new Game(resolve(mkdtempSync(resolve('work/test-invite-')), 'table.json'));
  const add = (name: string) =>
    game.command({ action: 'add', name, revision: game.state.revision });
  return { game, a: add('Alice'), b: add('Bob') };
}
describe('Personal invitations', () => {
  it('opens only the intended seat and can be viewed without changing existing access', () => {
    const { game, a, b } = setup();
    expect(a.invitation).not.toBe(b.invitation);
    const login = game.loginInvitation(a.invitation!);
    const before = structuredClone(game.state);
    const again = game.command({
      action: 'invite',
      playerId: a.playerId,
      revision: game.state.revision,
    });
    expect(again.invitation).toBe(a.invitation);
    expect(game.state).toEqual(before);
    expect(game.playerByToken(login.token)?.id).toBe(a.playerId);
    expect(JSON.stringify(game.view('player', login.token, new Set()))).not.toContain(a.invitation);
    expect(JSON.stringify(game.view('host', game.state.hostKey, new Set()))).not.toContain(
      a.invitation,
    );
    const resume = game.loginInvitation(a.invitation!, login.token);
    expect(resume.token).toBe(login.token);
    expect(game.state).toEqual(before);
  });
  it('survives restart and transfers the same cards to a new device', () => {
    const { game, a } = setup(),
      first = game.loginInvitation(a.invitation!);
    game.command({ action: 'deal', revision: game.state.revision });
    const cards = game.playerByToken(first.token)!.cards;
    const restored = new Game(game.file),
      second = restored.loginInvitation(a.invitation!);
    expect(restored.invitation(a.playerId!).invitation).toBe(a.invitation);
    expect(restored.playerByToken(first.token)).toBeUndefined();
    expect(restored.playerByToken(second.token)?.cards).toEqual(cards);
  });
  it('rejects tampering, revoked links and removed players', () => {
    const { game, a } = setup();
    expect(() => game.loginInvitation('0'.repeat(64))).toThrow('Ссылка недействительна');
    expect(() => game.loginInvitation('bad')).toThrow('Ссылка недействительна');
    const next = game.command({
      action: 'recode',
      playerId: a.playerId,
      revision: game.state.revision,
    });
    expect(next.invitation).not.toBe(a.invitation);
    expect(() => game.loginInvitation(a.invitation!)).toThrow();
    expect(game.loginInvitation(next.invitation!).playerId).toBe(a.playerId);
    game.command({ action: 'remove', playerId: a.playerId, revision: game.state.revision });
    expect(() => game.loginInvitation(next.invitation!)).toThrow();
  });
  it('keeps credentials out of the HTTP URL path and query', () => {
    const url = new URL(invitationLink('http://192.168.0.27:3000/host', 'a'.repeat(64)));
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('invite')).toBe('a'.repeat(64));
  });
});

it('starts a new game at hand one while preserving seats, tokens and invitations', () => {
  const { game, a, b } = setup();
  const session = game.loginInvitation(a.invitation!);
  game.command({ action: 'deal', revision: game.state.revision });
  game.command({ action: 'advance', revision: game.state.revision });
  const before = game.state.revision;
  game.command({ action: 'newGame', revision: before });
  expect(game.state.hand).toBe(0);
  expect(game.state.stage).toBe('waiting');
  expect(game.state.board).toEqual([]);
  expect(game.state.deck).toEqual([]);
  expect(game.state.burned).toEqual([]);
  expect([a.playerId, b.playerId]).toContain(game.state.dealerId);
  expect(game.state.dealerPending).toBe(true);
  expect(game.state.players.map((p) => p.id)).toEqual([a.playerId, b.playerId]);
  expect(game.playerByToken(session.token)?.cards).toEqual([]);
  expect(game.invitation(a.playerId!).invitation).toBe(a.invitation);
  expect(() => game.command({ action: 'newGame', revision: before })).toThrow();
  const restored = new Game(game.file);
  expect(restored.playerByToken(session.token)?.id).toBe(a.playerId);
  restored.command({ action: 'deal', revision: restored.state.revision });
  expect(restored.state.hand).toBe(1);
  expect(restored.playerByToken(session.token)?.cards).toHaveLength(2);
});
