import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game, shuffledDeck } from '../server/game';
import type { Action } from '../shared/types';
function fresh() {
  mkdirSync('work', { recursive: true });
  return new Game(resolve(mkdtempSync(resolve('work/test-game-')), 'table.json'));
}
function cmd(g: Game, action: Action, extra: Record<string, string> = {}) {
  return g.command({ action, revision: g.state.revision, ...extra });
}
function players(g: Game, n = 2) {
  return Array.from({ length: n }, (_, i) => cmd(g, 'add', { name: 'Player ' + i }).code!);
}
describe('Cards and table lifecycle', () => {
  it('saves rosters and starts a clean table with fresh player access', () => {
    const g = fresh();
    const codes = players(g);
    const session = g.login(codes[0]);
    const oldId = g.state.players[0].id;
    cmd(g, 'playerPresetSave', { name: 'Друзья' });
    const presetId = g.state.playerPresets[0].id;
    const restored = new Game(g.file);
    expect(restored.state.playerPresets[0].players).toEqual(['Player 0', 'Player 1']);
    cmd(g, 'deal');
    cmd(g, 'rebuy', { playerId: oldId });
    cmd(g, 'eliminate', { playerId: oldId });
    cmd(g, 'newTable', { playerPresetId: presetId });
    expect(g.state.players.map((p) => p.name)).toEqual(['Player 0', 'Player 1']);
    expect(g.state.players.every((p) => !p.eliminated && !p.rebuys && !p.cards.length)).toBe(true);
    expect(g.playerByToken(session.token)).toBeUndefined();
    expect(() => g.login(codes[0])).toThrow();
    expect(g.state.players[0].id).not.toBe(oldId);
    expect(g.state).toMatchObject({ stage: 'waiting', hand: 0, board: [] });
    expect(g.state.blinds).toMatchObject({ level: 0, running: false });
    expect(g.view('host', '', new Set()).playerPresets).toHaveLength(1);
    const before = structuredClone(g.state);
    expect(() => cmd(g, 'newTable', { playerPresetId: 'missing' })).toThrow();
    expect(g.state).toEqual(before);
    cmd(g, 'add', { name: 'Друг' });
    cmd(g, 'playerPresetSave', { name: 'Друзья' });
    expect(g.state.playerPresets).toHaveLength(1);
    expect(g.state.playerPresets[0].players).toHaveLength(3);
    cmd(g, 'newTable');
    expect(g.state.players).toEqual([]);
    expect(new Game(g.file).state.playerPresets).toHaveLength(1);
    cmd(g, 'newTable', { playerPresetId: presetId });
    const currentPlayers = structuredClone(g.state.players);
    cmd(g, 'playerPresetDelete', { playerPresetId: presetId });
    expect(g.state.players).toEqual(currentPlayers);
    expect(new Game(g.file).state.playerPresets).toEqual([]);
    expect(() => cmd(g, 'playerPresetDelete', { playerPresetId: presetId })).toThrow();
  });
  it('records rebuys during a hand, persists them and resets them only for a new game', () => {
    const g = fresh();
    players(g);
    const playerId = g.state.players[0].id;
    cmd(g, 'deal');
    const cards = [...g.state.players[0].cards];
    cmd(g, 'rebuy', { playerId });
    const revision = g.state.revision;
    cmd(g, 'rebuy', { playerId });
    expect(() => g.command({ action: 'rebuy', playerId, revision })).toThrow();
    expect(g.state.players[0].cards).toEqual(cards);
    const restored = new Game(g.file);
    expect(restored.view('host', '', new Set()).players[0].rebuys).toBe(2);
    cmd(restored, 'rebuyRemove', { playerId });
    expect(new Game(restored.file).state.players[0].rebuys).toBe(1);
    cmd(restored, 'rebuyRemove', { playerId });
    expect(() => cmd(restored, 'rebuyRemove', { playerId })).toThrow('нет ребаев');
    expect(restored.state.players[0].rebuys).toBe(0);
    cmd(restored, 'rebuy', { playerId });
    cmd(restored, 'rebuy', { playerId });
    cmd(restored, 'finish');
    expect(restored.state.players[0].rebuys).toBe(2);
    cmd(restored, 'newGame');
    expect(restored.state.players[0].rebuys).toBe(0);
    const legacy = JSON.parse(JSON.stringify(restored.state));
    legacy.players.forEach((p: { rebuys?: number }) => {
      delete p.rebuys;
    });
    writeFileSync(restored.file, JSON.stringify(legacy));
    expect(new Game(restored.file).state.players.every((p) => p.rebuys === 0)).toBe(true);
  });
  it('shuffles complete unique decks', () => {
    for (let i = 0; i < 100; i++) {
      const d = shuffledDeck();
      expect(d).toHaveLength(52);
      expect(new Set(d).size).toBe(52);
      expect(d.every((c) => /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)[SHDC]$/.test(c))).toBe(true);
    }
  });
  it('deals ten private hands, burns cards and reveals the board without duplicates', () => {
    const g = fresh();
    players(g, 10);
    cmd(g, 'deal');
    expect(g.state.players.every((p) => p.cards.length === 2)).toBe(true);
    expect(g.state.stage).toBe('preflop');
    expect(g.state.board).toHaveLength(0);
    cmd(g, 'advance');
    expect(g.state.board).toHaveLength(3);
    cmd(g, 'advance');
    expect(g.state.board).toHaveLength(4);
    cmd(g, 'advance');
    expect(g.state.board).toHaveLength(5);
    const all = [
      ...g.state.deck,
      ...g.state.board,
      ...g.state.burned,
      ...g.state.players.flatMap((p) => p.cards),
    ];
    expect(all).toHaveLength(52);
    expect(new Set(all).size).toBe(52);
    expect(g.state.burned).toHaveLength(3);
    expect(() => cmd(g, 'advance')).toThrow();
    cmd(g, 'finish');
    expect(g.state.stage).toBe('waiting');
    expect(g.state.players.every((p) => p.cards.length === 0)).toBe(true);
  });
  it('rejects duplicate/stale commands without changing the hand', () => {
    const g = fresh();
    players(g);
    const revision = g.state.revision;
    g.command({ action: 'deal', revision });
    const snapshot = structuredClone(g.state);
    expect(() => g.command({ action: 'deal', revision })).toThrow();
    expect(() => cmd(g, 'deal')).toThrow();
    expect(g.state).toEqual(snapshot);
  });
  it('rotates dealer and deals clockwise', () => {
    const g = fresh();
    players(g, 3);
    cmd(g, 'deal');
    const first = g.state.dealerId;
    cmd(g, 'finish');
    cmd(g, 'deal');
    expect(g.state.dealerId).not.toBe(first);
    const previous = g.state.players.findIndex((p) => p.id === first);
    expect(g.state.dealerId).toBe(g.state.players[(previous + 1) % 3].id);
  });
  it('validates player count, names and roster lock', () => {
    const g = fresh();
    expect(() => cmd(g, 'deal')).toThrow();
    expect(() => cmd(g, 'add', { name: ' ' })).toThrow();
    players(g, 10);
    expect(() => cmd(g, 'add', { name: 'extra' })).toThrow();
    cmd(g, 'deal');
    expect(() => cmd(g, 'remove', { playerId: g.state.players[0].id })).toThrow();
    expect(() => cmd(g, 'add', { name: 'new' })).toThrow();
  });
});
describe('Identity, privacy and persistence', () => {
  it('updates the result as hands are shown, including ties and elimination', () => {
    const g = fresh();
    const [a, b, c] = players(g, 3).map((code) => g.login(code));
    const view = () => g.view('host', g.state.hostKey, new Set());
    cmd(g, 'deal');
    g.showCards(a.token, g.state.hand);
    expect(view().winnerIds).toBeUndefined();
    expect(new Game(g.file).state.players[0].shown).toBe(true);
    g.fold(a.token, g.state.hand);
    expect(view().players[0].inHand).toBe(false);
    expect(() => g.showCards(a.token, g.state.hand)).toThrow();
    cmd(g, 'finish');
    cmd(g, 'deal');
    expect(view().players[0].inHand).toBe(true);
    const hands = [
      ['AH', 'AS'],
      ['6H', 'KS'],
      ['6D', 'QS'],
    ];
    const board = ['2C', '3D', '4H', '5C', '9S'];
    g.state.players.forEach((p, i) => {
      p.cards = hands[i];
    });
    g.state.deck = shuffledDeck().filter((card) => ![...board, ...hands.flat()].includes(card));
    const burns = g.state.deck.splice(0, 3);
    g.state.deck.push(
      board[4],
      burns[2],
      board[3],
      burns[1],
      board[2],
      board[1],
      board[0],
      burns[0],
    );
    for (let i = 0; i < 3; i++) cmd(g, 'advance');
    expect(view().winnerIds).toBeUndefined();
    g.showCards(a.token, g.state.hand);
    expect(view().winnerIds).toEqual([a.playerId]);
    expect(view().players[1].shownCards).toBeUndefined();
    g.showCards(b.token, g.state.hand);
    expect(view().winnerIds).toEqual([b.playerId]);
    g.showCards(c.token, g.state.hand);
    expect(view().winnerIds).toEqual([b.playerId, c.playerId]);
    cmd(g, 'eliminate', { playerId: b.playerId });
    expect(view().winnerIds).toEqual([c.playerId]);
    expect(new Game(g.file).state.players[1].eliminated).toBe(true);
    expect(g.view('player', b.token, new Set()).cards).toEqual([]);
    cmd(g, 'finish');
    cmd(g, 'setDealer', { playerId: c.playerId });
    cmd(g, 'deal');
    expect(g.state.dealerId).toBe(c.playerId);
    expect(g.state.players[1].cards).toEqual([]);
    cmd(g, 'finish');
    expect(g.state.dealerId).toBe(a.playerId);
    cmd(g, 'newGame');
    expect(g.state.players.every((p) => !p.eliminated)).toBe(true);
  });
  it('sends only own hand and public cards; host sees no hands', () => {
    const g = fresh(),
      codes = players(g);
    const a = g.login(codes[0]),
      b = g.login(codes[1]);
    cmd(g, 'deal');
    cmd(g, 'advance');
    const view = g.view('player', a.token, new Set());
    expect(view.cards).toEqual(g.state.players[0].cards);
    expect(view.board).toHaveLength(3);
    expect(Object.keys(view).sort()).toEqual(
      [
        'board',
        'blinds',
        'handBlinds',
        'serverNow',
        'cards',
        'dealerId',
        'dealerPending',
        'hand',
        'players',
        'revision',
        'role',
        'selfId',
        'stage',
      ].sort(),
    );
    expect(
      view.players.every((p) => !('cards' in p) && !('token' in p) && !('codeHash' in p)),
    ).toBe(true);
    const h = g.view('host', g.state.hostKey, new Set());
    expect(h.cards).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(a.token);
    expect(JSON.stringify(h)).not.toContain(b.token);
  });
  it('keeps cards on restart, reconnection, recode and replacement device', () => {
    const g = fresh(),
      codes = players(g),
      a = g.login(codes[0]);
    cmd(g, 'deal');
    const cards = [...g.state.players[0].cards];
    const restarted = new Game(g.file);
    expect(restarted.playerByToken(a.token)?.cards).toEqual(cards);
    const replacement = restarted.login(codes[0].toLowerCase());
    expect(restarted.playerByToken(a.token)).toBeUndefined();
    expect(restarted.playerByToken(replacement.token)?.cards).toEqual(cards);
    const reissued = cmd(restarted, 'recode', { playerId: a.playerId });
    expect(() => restarted.login(codes[0])).toThrow();
    expect(restarted.playerByToken(replacement.token)).toBeUndefined();
    const last = restarted.login(reissued.code!);
    expect(restarted.playerByToken(last.token)?.cards).toEqual(cards);
  });
  it('closing table revokes all player codes and tokens', () => {
    const g = fresh(),
      codes = players(g),
      a = g.login(codes[0]);
    cmd(g, 'deal');
    cmd(g, 'close');
    expect(g.state.players).toHaveLength(0);
    expect(g.playerByToken(a.token)).toBeUndefined();
    expect(() => g.login(codes[0])).toThrow();
  });
  it('rolls back changes if persistence fails', () => {
    const g = fresh();
    players(g);
    const before = structuredClone(g.state);
    vi.spyOn(g, 'save').mockImplementation(() => {
      throw new Error('Disk full');
    });
    expect(() => cmd(g, 'deal')).toThrow('Disk full');
    expect(g.state).toEqual(before);
  });
  it('does not silently replace a damaged save', () => {
    const g = fresh();
    writeFileSync(g.file, 'not json');
    expect(() => new Game(g.file)).toThrow();
  });
});
