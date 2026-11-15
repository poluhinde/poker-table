import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game } from '../server/game';
import type { Action, Command } from '../shared/types';
function setup(n = 5, pick: (n: number) => number = (count) => Math.min(2, count - 1)) {
  mkdirSync('work', { recursive: true });
  const game = new Game(resolve(mkdtempSync(resolve('work/test-dealer-')), 'table.json'), pick);
  for (let i = 0; i < n; i++) action(game, 'add', { name: 'Player ' + i });
  return { game, ids: game.state.players.map((p) => p.id) };
}
function action(game: Game, type: Action, extra: Partial<Command> = {}) {
  return game.command({ action: type, revision: game.state.revision, ...extra });
}
describe('Dealer button', () => {
  it.each([0, 1, 2, 3, 4])('can select any initial seat (%i), not always the first', (index) => {
    const pick = vi.fn(() => index),
      { game, ids } = setup(5, pick);
    action(game, 'deal');
    expect(pick).toHaveBeenCalledExactlyOnceWith(5);
    expect(game.state.dealerId).toBe(ids[index]);
  });
  it('selects immediately on a new game and keeps that player for the first hand', () => {
    const pick = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(4);
    const { game, ids } = setup(5, pick);
    action(game, 'newGame');
    expect(game.state.dealerId).toBe(ids[1]);
    expect(game.state.dealerPending).toBe(true);
    action(game, 'deal');
    expect(game.state.dealerId).toBe(ids[1]);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(game.state.dealerPending).toBe(false);
    action(game, 'advance');
    expect(game.state.dealerId).toBe(ids[1]);
    action(game, 'finish');
    expect(game.state.dealerId).toBe(ids[2]);
    action(game, 'deal');
    expect(game.state.dealerId).toBe(ids[2]);
    action(game, 'newGame');
    expect(game.state.dealerId).toBe(ids[4]);
    expect(pick).toHaveBeenCalledTimes(2);
  });
  it('moves once per hand clockwise and wraps around', () => {
    const { game, ids } = setup(3, (n) => n - 1);
    for (const expected of [ids[2], ids[0], ids[1], ids[2]]) {
      action(game, 'deal');
      expect(game.state.dealerId).toBe(expected);
      action(game, 'advance');
      expect(game.state.dealerId).toBe(expected);
      action(game, 'advance');
      action(game, 'advance');
      expect(game.state.dealerId).toBe(expected);
      action(game, 'finish');
      expect(game.state.dealerId).toBe(ids[(ids.indexOf(expected) + 1) % ids.length]);
      expect(game.state.dealerPending).toBe(true);
      const after = structuredClone(game.state);
      expect(() => action(game, 'finish')).toThrow();
      expect(game.state).toEqual(after);
      expect(new Game(game.file).state.dealerId).toBe(after.dealerId);
    }
  });
  it('does not skip the successor after deleting the current dealer', () => {
    const { game, ids } = setup();
    action(game, 'deal');
    action(game, 'finish');
    action(game, 'remove', { playerId: ids[3] });
    expect(game.state.dealerId).toBe(ids[4]);
    expect(game.state.dealerPending).toBe(true);
    const restored = new Game(game.file);
    action(restored, 'deal');
    expect(restored.state.dealerId).toBe(ids[4]);
    action(restored, 'finish');
    expect(restored.state.dealerId).toBe(ids[0]);
    action(restored, 'deal');
    expect(restored.state.dealerId).toBe(ids[0]);
  });
  it('handles consecutive removals and wraps without choosing randomly again', () => {
    const pick = vi.fn(() => 2),
      { game, ids } = setup(5, pick);
    action(game, 'deal');
    action(game, 'finish');
    for (const id of [ids[2], ids[3], ids[4]]) action(game, 'remove', { playerId: id });
    expect(game.state.dealerId).toBe(ids[0]);
    action(game, 'deal');
    expect(game.state.dealerId).toBe(ids[0]);
    expect(pick).toHaveBeenCalledTimes(1);
  });
  it('skips removed non-dealers and follows the current seating', () => {
    const { game, ids } = setup();
    action(game, 'deal');
    action(game, 'finish');
    action(game, 'remove', { playerId: ids[0] });
    action(game, 'remove', { playerId: ids[2] });
    expect(game.state.dealerId).toBe(ids[3]);
    action(game, 'reorder', { order: [ids[4], ids[3], ids[1]] });
    action(game, 'deal');
    expect(game.state.dealerId).toBe(ids[3]);
    action(game, 'finish');
    expect(game.state.dealerId).toBe(ids[1]);
  });
  it('retains an already selected successor after reordering', () => {
    const { game, ids } = setup();
    action(game, 'newGame');
    action(game, 'remove', { playerId: ids[2] });
    action(game, 'reorder', { order: [ids[3], ids[0], ids[1], ids[4]] });
    action(game, 'deal');
    expect(game.state.dealerId).toBe(ids[3]);
  });
  it('handles empty tables and removal of the only player', () => {
    const { game } = setup(0);
    action(game, 'newGame');
    expect(game.state.dealerId).toBe(null);
    action(game, 'add', { name: 'Only' });
    action(game, 'newGame');
    action(game, 'remove', { playerId: game.state.players[0].id });
    expect(game.state.dealerId).toBe(null);
    expect(game.state.dealerPending).toBe(false);
    expect(new Game(game.file).state.dealerId).toBe(null);
  });
  it('loads old saves without changing an active hand or dealer', () => {
    const { game } = setup();
    action(game, 'deal');
    const previous = structuredClone(game.state);
    const legacy = { ...previous } as Partial<typeof previous>;
    delete legacy.dealerPending;
    writeFileSync(game.file, JSON.stringify(legacy));
    const restored = new Game(game.file);
    expect(restored.state.dealerId).toBe(previous.dealerId);
    expect(restored.state.players).toEqual(previous.players);
    expect(restored.state.dealerPending).toBe(false);
  });
});
