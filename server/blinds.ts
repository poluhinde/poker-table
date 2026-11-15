import type { BlindClock, BlindSettings } from '../shared/types.js';

export function defaultBlinds(): BlindClock {
  return {
    enabled: true,
    alarmId: 0,
    awaitingDeal: false,
    minutes: 15,
    levels: [25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000, 1500].map((small) => ({
      small,
      big: small * 2,
    })),
    level: 0,
    running: false,
    endsAt: null,
    remainingMs: 15 * 60000,
  };
}

export function validSettings(value: BlindSettings): boolean {
  return (
    !!value &&
    typeof value.enabled === 'boolean' &&
    Number.isInteger(value.minutes) &&
    value.minutes >= 1 &&
    value.minutes <= 180 &&
    Array.isArray(value.levels) &&
    value.levels.length >= 1 &&
    value.levels.length <= 40 &&
    value.levels.every(
      (row, index) =>
        !!row &&
        Number.isSafeInteger(row.small) &&
        row.small > 0 &&
        row.small <= 1e9 &&
        Number.isSafeInteger(row.big) &&
        row.big >= row.small &&
        row.big <= 1e9 &&
        (index === 0 ||
          (row.small >= value.levels[index - 1].small && row.big > value.levels[index - 1].big)),
    )
  );
}

export function validClock(clock: BlindClock): boolean {
  return (
    validSettings(clock) &&
    Number.isInteger(clock.level) &&
    clock.level >= 0 &&
    clock.level < clock.levels.length &&
    typeof clock.running === 'boolean' &&
    typeof clock.awaitingDeal === 'boolean' &&
    !(clock.awaitingDeal && clock.running) &&
    Number.isSafeInteger(clock.alarmId) &&
    clock.alarmId >= 0 &&
    Number.isFinite(clock.remainingMs) &&
    clock.remainingMs >= 0 &&
    clock.remainingMs <= 180 * 60000 &&
    (clock.running
      ? Number.isSafeInteger(clock.endsAt) && clock.endsAt! > 0
      : clock.endsAt === null)
  );
}

export function resetBlinds(clock: BlindClock) {
  clock.level = 0;
  clock.alarmId = 0;
  clock.awaitingDeal = false;
  clock.running = false;
  clock.endsAt = null;
  clock.remainingMs = clock.minutes * 60000;
}

// Absolute deadlines preserve elapsed time across sleeping tabs and server restarts.
export function advanceBlinds(clock: BlindClock, now: number): boolean {
  if (!clock.running || clock.endsAt === null || now < clock.endsAt) return false;
  clock.alarmId++;
  clock.running = false;
  clock.endsAt = null;
  clock.awaitingDeal = clock.enabled && clock.level < clock.levels.length - 1;
  if (clock.awaitingDeal) {
    clock.level++;
    clock.remainingMs = clock.minutes * 60000;
  } else clock.remainingMs = 0;
  return true;
}
