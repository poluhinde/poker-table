import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Game, type State } from '../server/game';
import type { Action, Command } from '../shared/types';

function setup() {
  mkdirSync('work', { recursive: true });
  let now = 1000000;
  const file = resolve(mkdtempSync(resolve('work/test-blinds-')), 'table.json');
  const game = new Game(
    file,
    () => 0,
    () => now,
  );
  const command = (action: Action, extra: Partial<Command> = {}) =>
    game.command({ action, revision: game.state.revision, ...extra });
  const elapse = (milliseconds: number) => {
    now += milliseconds;
    return game.tick();
  };
  return { game, command, elapse, now: () => now };
}

describe('Blind clock', () => {
  it('deletes a saved preset without changing the active clock', () => {
    const x = setup();
    x.command('blindPresetSave', { name: 'Быстрый', blindSettings: x.game.state.blinds });
    const blindPresetId = x.game.state.blindPresets[0].id;
    x.command('blindStart');
    const clock = structuredClone(x.game.state.blinds);
    x.command('blindPresetDelete', { blindPresetId });
    expect(x.game.state.blinds).toEqual(clock);
    expect(new Game(x.game.file).state.blindPresets).toEqual([]);
    expect(() => x.command('blindPresetDelete', { blindPresetId })).toThrow();
  });
  it('keeps an expired level paused through all streets until the next deal', () => {
    const x = setup();
    x.command('add', { name: 'A' });
    x.command('add', { name: 'B' });
    x.command('deal');
    x.elapse(900000);
    const expired = structuredClone(x.game.state.blinds);
    for (const stage of ['flop', 'turn', 'river']) {
      x.command('advance');
      expect(x.game.state.stage).toBe(stage);
      expect(x.game.state.blinds).toEqual(expired);
      expect(x.elapse(1000)).toBe(false);
    }
    x.command('finish');
    x.command('deal');
    expect(x.game.state.blinds).toMatchObject({ running: true, awaitingDeal: false });
    expect(x.game.state.blinds.endsAt).toBe(x.now() + expired.remainingMs);
  });
  it('resumes paused time on each board street', () => {
    const x = setup();
    x.command('add', { name: 'A' });
    x.command('add', { name: 'B' });
    x.command('deal');
    for (const stage of ['flop', 'turn', 'river']) {
      x.elapse(1000);
      x.command('blindPause');
      const remaining = x.game.state.blinds.remainingMs;
      x.elapse(5000);
      x.command('advance');
      expect(x.game.state.stage).toBe(stage);
      expect(x.game.state.blinds.running).toBe(true);
      expect(x.game.state.blinds.endsAt).toBe(x.now() + remaining);
    }
  });
  it('advances once at expiry and waits for a deal without consuming the next level time', () => {
    const x = setup();
    x.command('blindStart');
    expect(x.elapse(899999)).toBe(false);
    expect(x.elapse(1)).toBe(true);
    expect(x.game.state.blinds).toMatchObject({
      level: 1,
      running: false,
      awaitingDeal: true,
      endsAt: null,
      remainingMs: 900000,
      alarmId: 1,
    });
    expect(x.elapse(900000 * 20)).toBe(false);
    expect(x.game.state.blinds.level).toBe(1);
    expect(x.game.state.blinds.remainingMs).toBe(900000);
    expect(() => x.command('blindStart')).toThrow('следующей раздаче');
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    expect(x.game.state.blinds).toMatchObject({ running: true, awaitingDeal: false });
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 900000);
    expect(x.game.state.handBlinds).toEqual({ small: 50, big: 100 });
  });

  it('stops at the final level and permits repeating its countdown', () => {
    const x = setup();
    x.command('blindSettings', {
      blindSettings: { ...x.game.state.blinds, levels: [{ small: 25, big: 50 }] },
    });
    x.command('blindStart');
    x.elapse(900000);
    expect(x.game.state.blinds).toMatchObject({
      level: 0,
      running: false,
      remainingMs: 0,
      awaitingDeal: false,
    });
    x.command('blindStart');
    expect(x.game.state.blinds.running).toBe(true);
  });

  it('pauses with the precise remaining time and resumes without losing it', () => {
    const x = setup();
    x.command('blindStart');
    x.elapse(123456);
    x.command('blindPause');
    expect(x.game.state.blinds.remainingMs).toBe(900000 - 123456);
    x.elapse(9000000);
    expect(x.game.state.blinds.level).toBe(0);
    x.command('blindStart');
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 900000 - 123456);
    x.elapse(900000 - 123456);
    expect(x.game.state.blinds.level).toBe(1);
  });

  it('keeps current-hand blinds fixed and applies the new level to the next deal', () => {
    const x = setup();
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('blindStart');
    x.command('deal');
    x.elapse(900000);
    expect(x.game.view('host', '', new Set()).handBlinds).toEqual({ small: 25, big: 50 });
    expect(x.game.state.blinds.level).toBe(1);
    x.command('finish');
    expect(x.game.state.handBlinds).toBeNull();
    x.command('deal');
    expect(x.game.state.handBlinds).toEqual({ small: 50, big: 100 });
    x.command('blindReset');
    expect(x.game.state.handBlinds).toEqual({ small: 50, big: 100 });
  });

  it('restores paused clocks and selects only one next level after server downtime', () => {
    const x = setup();
    x.command('blindStart');
    const restarted = new Game(
      x.game.file,
      () => 0,
      () => x.now() + 900000 * 2 + 3000,
    );
    expect(restarted.state.blinds.level).toBe(1);
    expect(restarted.state.blinds.endsAt).toBeNull();
    expect(restarted.state.blinds.remainingMs).toBe(900000);
    expect(restarted.state.blinds.awaitingDeal).toBe(true);
    x.command('blindPause');
    const paused = new Game(
      x.game.file,
      () => 0,
      () => x.now() + 9999999,
    );
    expect(paused.state.blinds).toEqual(x.game.state.blinds);
  });

  it('validates settings and preserves the running level when future levels are edited', () => {
    const x = setup();
    const settings = {
      enabled: true,
      minutes: 10,
      levels: [
        { small: 100, big: 200 },
        { small: 200, big: 400 },
      ],
    };
    for (const invalid of [
      { ...settings, minutes: 0 },
      { ...settings, minutes: 181 },
      { ...settings, minutes: 1.5 },
      { ...settings, levels: [] },
      { ...settings, levels: [{ small: 0, big: 50 }] },
      { ...settings, levels: [{ small: 100, big: 50 }] },
      {
        ...settings,
        levels: [
          { small: 25, big: 50 },
          { small: 25, big: 50 },
        ],
      },
    ])
      expect(() => x.command('blindSettings', { blindSettings: invalid })).toThrow();
    x.command('blindSettings', { blindSettings: settings });
    expect(x.game.state.blinds.remainingMs).toBe(600000);
    x.command('blindStart');
    x.elapse(12345);
    const deadline = x.game.state.blinds.endsAt;
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    x.command('blindSettings', {
      blindSettings: {
        ...settings,
        minutes: 1,
        levels: [settings.levels[0], { small: 300, big: 600 }],
      },
    });
    expect(x.game.state.blinds.endsAt).toBe(deadline);
    expect(x.game.state.blinds.running).toBe(true);
    expect(x.game.state.blinds.level).toBe(0);
    expect(x.game.state.handBlinds).toEqual(settings.levels[0]);
    expect(x.game.state.blinds.levels[1]).toEqual({ small: 300, big: 600 });
    expect(() => x.command('blindSettings', { blindSettings: settings, blindLevel: 1 })).toThrow(
      'Уровень',
    );
    expect(() =>
      x.command('blindSettings', {
        blindSettings: { ...settings, levels: [{ small: 50, big: 100 }, settings.levels[1]] },
      }),
    ).toThrow('только уровни');
    const restored = new Game(x.game.file, () => 0, x.now);
    expect(restored.state.blinds.endsAt).toBe(deadline);
    x.elapse(600000 - 12345);
    expect(x.game.state.blinds.level).toBe(1);
    expect(x.game.state.blinds.remainingMs).toBe(60000);
    expect(x.game.state.blinds.awaitingDeal).toBe(true);
  });

  it('supports manual advance, resets on new game and retains settings', () => {
    const x = setup();
    x.command('blindNext');
    expect(x.game.state.blinds.level).toBe(1);
    expect(x.game.state.blinds.running).toBe(false);
    x.command('blindStart');
    x.elapse(1000);
    x.command('blindNext');
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 900000);
    const settings = x.game.state.blinds.levels;
    x.command('newGame');
    expect(x.game.state.blinds.level).toBe(0);
    expect(x.game.state.blinds.running).toBe(false);
    expect(x.game.state.blinds.levels).toEqual(settings);
    x.command('blindSettings', { blindSettings: { ...x.game.state.blinds, enabled: false } });
    x.command('blindStart');
    expect(x.game.state.blinds.running).toBe(true);
    x.command('blindNext');
    expect(x.game.state.blinds.level).toBe(1);
  });

  it('starts on deal and resumes a paused clock without resetting time on subsequent deals', () => {
    const x = setup();
    expect(() => x.command('deal')).toThrow();
    expect(x.game.state.blinds.running).toBe(false);
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    const deadline = x.game.state.blinds.endsAt;
    expect(deadline).toBe(x.now() + 900000);
    x.elapse(10000);
    x.command('finish');
    x.command('deal');
    expect(x.game.state.blinds.endsAt).toBe(deadline);
    x.command('blindPause');
    x.command('finish');
    x.elapse(20000);
    x.command('deal');
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 890000);
    x.command('finish');
    x.command('blindPause');
    x.command('blindSettings', { blindSettings: { ...x.game.state.blinds, enabled: false } });
    x.command('deal');
    expect(x.game.state.blinds.running).toBe(true);
    expect(x.game.state.handBlinds).toEqual({ small: 25, big: 50 });
  });

  it('removes future levels immediately without changing current blinds or time', () => {
    const x = setup();
    x.command('blindStart');
    x.elapse(12345);
    const before = structuredClone(x.game.state.blinds);
    x.command('blindRemove', { blindLevel: 1 });
    expect(x.game.state.blinds.levels[1]).toEqual(before.levels[2]);
    expect(x.game.state.blinds.endsAt).toBe(before.endsAt);
    expect(x.game.state.blinds.remainingMs).toBe(before.remainingMs);
    expect(x.game.state.blinds.running).toBe(true);
    expect(() => x.command('blindRemove', { blindLevel: 0 })).toThrow();
    expect(() => x.command('blindRemove', { blindLevel: -1 })).toThrow();
    expect(() => x.command('blindRemove', { blindLevel: 99 })).toThrow();
    x.elapse(900000 - 12345);
    expect(x.game.state.blinds.levels[x.game.state.blinds.level]).toEqual(before.levels[2]);
    expect(() => x.command('blindRemove', { blindLevel: 0 })).toThrow();
  });

  it('allows removal of future rows through settings without resetting a paused clock', () => {
    const x = setup();
    x.command('blindStart');
    x.elapse(5000);
    x.command('blindPause');
    const before = structuredClone(x.game.state.blinds);
    x.command('blindSettings', {
      blindSettings: {
        ...before,
        minutes: 5,
        levels: before.levels.filter((_, index) => index !== 1),
      },
    });
    expect(x.game.state.blinds.remainingMs).toBe(before.remainingMs);
    expect(x.game.state.blinds.level).toBe(before.level);
    expect(x.game.state.blinds.running).toBe(false);
    expect(new Game(x.game.file).state.blinds.remainingMs).toBe(before.remainingMs);
  });

  it('moves to the previous level, preserves a running clock and protects current-hand blinds', () => {
    const x = setup();
    expect(() => x.command('blindPrevious')).toThrow();
    x.command('blindNext');
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    expect(x.game.state.blinds.running).toBe(true);
    x.elapse(10000);
    x.command('blindPrevious');
    expect(x.game.state.blinds.level).toBe(0);
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 900000);
    expect(x.game.state.handBlinds).toEqual({ small: 50, big: 100 });
    x.command('blindPause');
    x.command('blindNext');
    x.command('blindPrevious');
    expect(x.game.state.blinds.running).toBe(false);
    expect(x.game.state.blinds.remainingMs).toBe(900000);
  });

  it('saves named structures without altering the live clock, updates by name and restores on restart', () => {
    const x = setup();
    x.command('blindStart');
    x.elapse(10000);
    const clock = structuredClone(x.game.state.blinds);
    const settings = {
      enabled: true,
      minutes: 5,
      levels: [
        { small: 50, big: 100 },
        { small: 100, big: 200 },
      ],
    };
    x.command('blindPresetSave', { name: ' Быстрый ', blindSettings: settings });
    const id = x.game.state.blindPresets[0].id;
    expect(x.game.state.blinds).toEqual(clock);
    expect(x.game.state.blindPresets[0].name).toBe('Быстрый');
    x.command('blindPresetSave', { name: 'быстрый', blindSettings: { ...settings, minutes: 10 } });
    expect(x.game.state.blindPresets).toHaveLength(1);
    expect(x.game.state.blindPresets[0].id).toBe(id);
    expect(x.game.state.blindPresets[0].minutes).toBe(10);
    const restored = new Game(x.game.file, () => 0, x.now);
    expect(restored.state.blindPresets).toEqual(x.game.state.blindPresets);
    expect(restored.state.blinds).toEqual(clock);
    for (const name of ['', ' ', 'a'.repeat(41)])
      expect(() => x.command('blindPresetSave', { name, blindSettings: settings })).toThrow();
    expect(() =>
      x.command('blindPresetSave', { name: 'Invalid', blindSettings: { ...settings, levels: [] } }),
    ).toThrow();
  });

  it('selects a saved structure only with a new game and retains presets across table resets', () => {
    const x = setup();
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    const players = structuredClone(x.game.state.players);
    const settings = {
      enabled: true,
      minutes: 5,
      levels: [
        { small: 50, big: 100 },
        { small: 100, big: 200 },
      ],
    };
    x.command('blindPresetSave', { name: 'Быстрый', blindSettings: settings });
    const preset = structuredClone(x.game.state.blindPresets[0]);
    expect(x.game.state.blinds.minutes).toBe(15);
    const before = structuredClone(x.game.state);
    expect(() => x.command('newGame', { blindPresetId: 'missing' })).toThrow('не найден');
    expect(x.game.state).toEqual(before);
    x.command('newGame', { blindPresetId: preset.id });
    expect(x.game.state.hand).toBe(0);
    expect(x.game.state.stage).toBe('waiting');
    expect(x.game.state.blinds).toMatchObject({
      level: 0,
      minutes: 5,
      levels: settings.levels,
      running: false,
      remainingMs: 300000,
    });
    expect(x.game.state.players.map((p) => p.id)).toEqual(players.map((p) => p.id));
    expect(x.game.state.players.map((p) => p.codeHash)).toEqual(players.map((p) => p.codeHash));
    x.game.state.blinds.levels[0].small = 75;
    expect(x.game.state.blindPresets[0]).toEqual(preset);
    x.command('close');
    expect(x.game.state.blindPresets).toEqual([preset]);
  });

  it('rolls back preset creation when disk persistence fails', () => {
    const x = setup();
    const before = structuredClone(x.game.state);
    vi.spyOn(x.game, 'save').mockImplementation(() => {
      throw new Error('Disk full');
    });
    expect(() =>
      x.command('blindPresetSave', { name: 'Quick', blindSettings: x.game.state.blinds }),
    ).toThrow('Disk full');
    expect(x.game.state).toEqual(before);
  });

  it('expires in manual mode with one alarm, retains blinds and starts the next level on request', () => {
    const x = setup();
    x.command('blindSettings', {
      blindSettings: { ...x.game.state.blinds, enabled: false, minutes: 1 },
    });
    x.command('add', { name: 'Alice' });
    x.command('add', { name: 'Bob' });
    x.command('deal');
    expect(x.game.state.blinds.running).toBe(true);
    x.elapse(60000);
    expect(x.game.state.blinds).toMatchObject({
      enabled: false,
      level: 0,
      running: false,
      remainingMs: 0,
      endsAt: null,
      alarmId: 1,
    });
    expect(x.game.state.handBlinds).toEqual({ small: 25, big: 50 });
    expect(x.elapse(120000)).toBe(false);
    expect(x.game.state.blinds.alarmId).toBe(1);
    expect(new Game(x.game.file, () => 0, x.now).state.blinds).toEqual(x.game.state.blinds);
    x.command('blindNext');
    expect(x.game.state.blinds).toMatchObject({ level: 1, running: true, remainingMs: 60000 });
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 60000);
    expect(x.game.state.handBlinds).toEqual({ small: 25, big: 50 });
  });

  it('changes mode without stopping the current countdown', () => {
    const x = setup();
    x.command('blindStart');
    const deadline = x.game.state.blinds.endsAt;
    x.command('blindSettings', { blindSettings: { ...x.game.state.blinds, enabled: false } });
    expect(x.game.state.blinds.endsAt).toBe(deadline);
    x.elapse(900000);
    expect(x.game.state.blinds.level).toBe(0);
    expect(x.game.state.blinds.alarmId).toBe(1);
    x.command('blindStart');
    expect(x.game.state.blinds.endsAt).toBe(x.now() + 900000);
    x.command('newGame');
    expect(x.game.state.blinds.alarmId).toBe(0);
    expect(x.game.state.blinds.awaitingDeal).toBe(false);
  });

  it('migrates existing saves and rejects corrupt clock state', () => {
    const x = setup();
    const legacy: Partial<State> = JSON.parse(readFileSync(x.game.file, 'utf8'));
    delete legacy.blinds;
    delete legacy.handBlinds;
    delete legacy.blindPresets;
    writeFileSync(x.game.file, JSON.stringify(legacy));
    expect(new Game(x.game.file).state.blinds.level).toBe(0);
    expect(new Game(x.game.file).state.blindPresets).toEqual([]);
    writeFileSync(
      x.game.file,
      JSON.stringify({ ...x.game.state, blinds: { ...x.game.state.blinds, level: 100 } }),
    );
    expect(() => new Game(x.game.file)).toThrow('повреждён');
  });

  it('rolls back automatic advancement if saving fails', () => {
    const x = setup();
    x.command('blindStart');
    const before = structuredClone(x.game.state);
    vi.spyOn(x.game, 'save').mockImplementation(() => {
      throw new Error('Disk full');
    });
    expect(() => x.elapse(900000)).toThrow('Disk full');
    expect(x.game.state).toEqual(before);
  });
});
