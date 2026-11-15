import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../server/game';
import { moveSeat } from '../src/useSeatOrder';

function setup() {
  mkdirSync('work', { recursive: true });
  const game = new Game(resolve(mkdtempSync(resolve('work/test-reorder-')), 'table.json'));
  const invitations = ['Alice', 'Bob', 'Carol', 'Dan'].map((name) =>
    game.command({ action: 'add', name, revision: game.state.revision }),
  );
  const sessions = invitations.map((i) => game.loginInvitation(i.invitation!));
  return { game, invitations, sessions, ids: game.state.players.map((p) => p.id) };
}
describe('Seating order', () => {
  it('preserves player access during random seating and permits manual reordering afterwards', () => {
    const { game, ids, sessions } = setup();
    game.command({ action: 'newGame', randomSeating: true, revision: game.state.revision });
    expect(game.state.players.map((p) => p.id).sort()).toEqual([...ids].sort());
    const restored = new Game(game.file);
    expect(restored.state.players).toEqual(game.state.players);
    sessions.forEach((session, i) =>
      expect(restored.playerByToken(session.token)?.id).toBe(ids[i]),
    );
    const order = [...ids].reverse();
    restored.command({ action: 'reorder', order, revision: restored.state.revision });
    expect(restored.state.players.map((p) => p.id)).toEqual(order);
    restored.command({
      action: 'newGame',
      randomSeating: false,
      revision: restored.state.revision,
    });
    expect(restored.state.players.map((p) => p.id)).toEqual(order);
  });
  it('inserts a row at its target rather than merely swapping two seats', () => {
    expect(moveSeat(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveSeat(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
    const order = ['a', 'b'];
    expect(moveSeat(order, 'a', -1)).toBe(order);
  });
  it('persists the order while preserving player identities, access and dealer', () => {
    const { game, invitations, sessions, ids } = setup();
    game.command({ action: 'deal', revision: game.state.revision });
    game.command({ action: 'finish', revision: game.state.revision });
    const dealer = game.state.dealerId;
    const order = [ids[2], ids[0], ids[3], ids[1]];
    game.command({ action: 'reorder', order, revision: game.state.revision });
    expect(game.state.players.map((p) => p.id)).toEqual(order);
    expect(game.state.dealerId).toBe(dealer);
    const restored = new Game(game.file);
    sessions.forEach((s, i) => {
      expect(restored.playerByToken(s.token)?.id).toBe(ids[i]);
      expect(restored.invitation(ids[i]).invitation).toBe(invitations[i].invitation);
      expect(
        restored.view('player', s.token, new Set()).players.find((p) => p.id === ids[i])?.seat,
      ).toBe(order.indexOf(ids[i]) + 1);
    });
    restored.command({ action: 'deal', revision: restored.state.revision });
    expect(restored.state.dealerId).toBe(dealer);
  });
  it('rejects missing, duplicate, foreign and malformed ids without altering state', () => {
    const { game, ids } = setup(),
      before = structuredClone(game.state);
    for (const order of [
      [],
      ids.slice(1),
      [ids[0], ids[0], ids[2], ids[3]],
      ['foreign', ...ids.slice(1)],
      null,
      'bad',
      [1, 2, 3, 4],
    ]) {
      expect(() =>
        game.command({
          action: 'reorder',
          order: order as string[],
          revision: game.state.revision,
        }),
      ).toThrow();
      expect(game.state).toEqual(before);
    }
  });
  it('locks seating during a hand and rejects stale or repeated changes', () => {
    const { game, ids } = setup();
    game.command({ action: 'deal', revision: game.state.revision });
    expect(() =>
      game.command({ action: 'reorder', order: [...ids].reverse(), revision: game.state.revision }),
    ).toThrow('между раздачами');
    game.command({ action: 'finish', revision: game.state.revision });
    const revision = game.state.revision;
    game.command({ action: 'reorder', order: [...ids].reverse(), revision });
    expect(() => game.command({ action: 'reorder', order: ids, revision })).toThrow(
      'Стол уже изменился',
    );
  });
});
