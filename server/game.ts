import { randomInt, randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  Card,
  Stage,
  TableView,
  Command,
  Result,
  BlindClock,
  BlindLevel,
  BlindPreset,
  PlayerPreset,
} from '../shared/types.js';
import { defaultBlinds, validSettings, validClock, resetBlinds, advanceBlinds } from './blinds.js';
import { holdemHand, combinationName } from './holdem.js';

interface Player {
  id: string;
  name: string;
  codeHash: string;
  token: string | null;
  cards: Card[];
  eliminated: boolean;
  rebuys: number;
  shown: boolean;
  folded?: boolean;
}
export interface State {
  version: 1;
  revision: number;
  hand: number;
  stage: Stage;
  board: Card[];
  deck: Card[];
  burned: Card[];
  dealerId: string | null;
  dealerPending: boolean;
  hostKey: string;
  hostCode?: string;
  players: Player[];
  blinds: BlindClock;
  handBlinds: BlindLevel | null;
  blindPresets: BlindPreset[];
  playerPresets: PlayerPreset[];
}
export const secret = () => randomBytes(32).toString('hex');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const normalizeCode = (s: string) => s.toUpperCase().replace(/[-\s]/g, '');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(length = 10) {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function shuffledDeck(): Card[] {
  const cards = ['S', 'H', 'D', 'C'].flatMap((s) =>
    ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((r) => r + s),
  );
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function initial(): State {
  return {
    version: 1,
    revision: 0,
    hand: 0,
    stage: 'waiting',
    board: [],
    deck: [],
    burned: [],
    dealerId: null,
    dealerPending: false,
    hostKey: secret(),
    players: [],
    blinds: defaultBlinds(),
    handBlinds: null,
    blindPresets: [],
    playerPresets: [],
  };
}
export class Game {
  state: State;
  constructor(
    readonly file: string,
    private readonly chooseDealer: (count: number) => number = (count) => randomInt(count),
    private readonly now: () => number = Date.now,
  ) {
    this.state = existsSync(file) ? this.load() : initial();
    if (!this.state.hostCode) {
      this.state.hostCode = newCode(5);
      this.save();
    }
    this.tick();
  }
  private load(): State {
    const value = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as State;
    if (
      value.version !== 1 ||
      !Array.isArray(value.players) ||
      typeof value.hostKey !== 'string' ||
      value.hostKey.length !== 64 ||
      !['waiting', 'preflop', 'flop', 'turn', 'river'].includes(value.stage)
    )
      throw new Error(
        'Файл состояния повреждён. Сохраните его копию и восстановите корректный файл.',
      );
    // Existing saved tables have a current dealer, not a preselected next dealer.
    value.dealerPending ??= false;
    const bad = () => {
      throw new Error('Файл состояния повреждён. Сохраните его копию перед восстановлением.');
    };
    value.blinds ??= defaultBlinds();
    value.blinds.alarmId ??= 0;
    value.blinds.awaitingDeal ??= false;
    value.handBlinds ??= null;
    value.blindPresets ??= [];
    value.playerPresets ??= [];
    if (
      !Array.isArray(value.playerPresets) ||
      value.playerPresets.length > 50 ||
      value.playerPresets.some(
        (preset) =>
          !preset ||
          typeof preset.id !== 'string' ||
          !preset.id ||
          typeof preset.name !== 'string' ||
          !preset.name.trim() ||
          preset.name.length > 40 ||
          !Array.isArray(preset.players) ||
          !preset.players.length ||
          preset.players.length > 10 ||
          preset.players.some(
            (name) => typeof name !== 'string' || !name.trim() || name.length > 24,
          ) ||
          new Set(preset.players.map((name) => name.toLowerCase())).size !== preset.players.length,
      ) ||
      new Set(value.playerPresets.map((preset) => preset.id)).size !== value.playerPresets.length ||
      new Set(value.playerPresets.map((preset) => preset.name.toLocaleLowerCase('ru-RU'))).size !==
        value.playerPresets.length
    )
      bad();
    if (
      !Array.isArray(value.blindPresets) ||
      value.blindPresets.length > 50 ||
      value.blindPresets.some(
        (p) =>
          !p ||
          typeof p.id !== 'string' ||
          !p.id ||
          typeof p.name !== 'string' ||
          !p.name.trim() ||
          p.name.length > 40 ||
          !validSettings({ ...p, enabled: true }),
      ) ||
      new Set(value.blindPresets.map((p) => p.id)).size !== value.blindPresets.length ||
      new Set(value.blindPresets.map((p) => p.name.trim().toLocaleLowerCase('ru-RU'))).size !==
        value.blindPresets.length
    )
      bad();
    if (
      !validClock(value.blinds) ||
      (value.handBlinds !== null &&
        !validSettings({ enabled: true, minutes: 1, levels: [value.handBlinds] }))
    )
      bad();
    if (
      (value.hostCode !== undefined &&
        (typeof value.hostCode !== 'string' || !/^[A-HJ-NP-Z2-9]{5}$/.test(value.hostCode))) ||
      typeof value.dealerPending !== 'boolean' ||
      (value.dealerPending && value.dealerId === null)
    )
      bad();
    const secretPattern = /^[a-f0-9]{64}$/;
    if (
      !secretPattern.test(value.hostKey) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.hand) ||
      value.hand < 0 ||
      value.players.length > 10
    )
      bad();
    if (!Array.isArray(value.board) || !Array.isArray(value.deck) || !Array.isArray(value.burned))
      bad();
    for (const p of value.players) {
      if (p) {
        p.eliminated ??= false;
        p.rebuys ??= 0;
        p.shown ??= false;
        p.folded ??= false;
      }
      if (
        !p ||
        typeof p.id !== 'string' ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 24 ||
        !secretPattern.test(p.codeHash) ||
        !(p.token === null || (typeof p.token === 'string' && secretPattern.test(p.token))) ||
        !Array.isArray(p.cards) ||
        typeof p.eliminated !== 'boolean' ||
        !Number.isSafeInteger(p.rebuys) ||
        p.rebuys < 0 ||
        typeof p.shown !== 'boolean' ||
        typeof p.folded !== 'boolean' ||
        (p.shown && (p.eliminated || p.folded || value.stage === 'waiting')) ||
        (p.cards.length !== (value.stage === 'waiting' ? 0 : 2) &&
          !(p.eliminated && p.cards.length === 0))
      )
        bad();
    }
    if (
      new Set(value.players.map((p) => p.id)).size !== value.players.length ||
      new Set(value.players.map((p) => p.codeHash)).size !== value.players.length
    )
      bad();
    if (
      value.dealerId !== null &&
      !value.players.some((p) => p.id === value.dealerId && !p.eliminated)
    )
      bad();
    const expectedBoard = { waiting: 0, preflop: 0, flop: 3, turn: 4, river: 5 }[value.stage];
    const expectedBurn = { waiting: 0, preflop: 0, flop: 1, turn: 2, river: 3 }[value.stage];
    if (value.board.length !== expectedBoard || value.burned.length !== expectedBurn) bad();
    const all = [
      ...value.deck,
      ...value.board,
      ...value.burned,
      ...value.players.flatMap((p) => p.cards),
    ];
    const active = value.stage !== 'waiting';
    if (active && (value.players.filter((p) => p.cards.length === 2).length < 2 || value.hand < 1))
      bad();
    if (
      all.length !== (active ? 52 : 0) ||
      new Set(all).size !== all.length ||
      !all.every((c) => typeof c === 'string' && /^(2|3|4|5|6|7|8|9|10|J|Q|K|A)[SHDC]$/.test(c))
    )
      bad();
    return value;
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
  }
  private transaction<T>(fn: () => T): T {
    const before = structuredClone(this.state);
    try {
      const result = fn();
      this.state.revision++;
      this.save();
      return result;
    } catch (e) {
      this.state = before;
      throw e;
    }
  }
  playerByToken(token: string) {
    return this.state.players.find((p) => p.token === token && token.length === 64);
  }
  tick(): boolean {
    const clock = this.state.blinds;
    if (!clock.running || clock.endsAt === null || this.now() < clock.endsAt) return false;
    return this.transaction(() => advanceBlinds(clock, this.now()));
  }
  login(code: string): { token: string; playerId: string; previousToken: string | null } {
    if (typeof code !== 'string' || code.length > 40) throw new Error('Неверный код игрока');
    const p = this.state.players.find((p) => p.codeHash === hash(normalizeCode(code)));
    if (!p) throw new Error('Неверный код игрока');
    return this.transaction(() => {
      const previousToken = p.token;
      p.token = secret();
      return { token: p.token, playerId: p.id, previousToken };
    });
  }
  private invitationKey(p: Player) {
    return createHmac('sha256', this.state.hostKey)
      .update('player-invitation:' + p.id + ':' + p.codeHash)
      .digest('hex');
  }
  invitation(playerId: string): Result {
    const p = this.state.players.find((p) => p.id === playerId);
    if (!p) throw new Error('Игрок не найден');
    return { ok: true, name: p.name, playerId: p.id, invitation: this.invitationKey(p) };
  }
  loginInvitation(invitation: string, currentToken?: string) {
    const p =
      typeof invitation === 'string' && /^[a-f0-9]{64}$/.test(invitation)
        ? this.state.players.find((p) => this.invitationKey(p) === invitation)
        : undefined;
    if (!p)
      throw new Error('Ссылка недействительна. Попросите ведущего показать актуальный QR-код.');
    if (currentToken && p.token === currentToken) return { token: p.token, playerId: p.id };
    return this.transaction(() => {
      p.token = secret();
      return { token: p.token, playerId: p.id };
    });
  }
  showCards(token: string, hand: number): void {
    const p = this.playerByToken(token);
    if (
      hand !== this.state.hand ||
      this.state.stage === 'waiting' ||
      !p ||
      p.eliminated ||
      p.folded ||
      p.cards.length !== 2
    )
      throw new Error('Сейчас нельзя открыть карты');
    if (!p.shown)
      this.transaction(() => {
        p.shown = true;
      });
  }
  fold(token: string, hand: number): void {
    const p = this.playerByToken(token);
    if (!p || p.eliminated || hand !== this.state.hand || this.state.stage === 'waiting')
      throw new Error('Сейчас нельзя сбросить карты');
    if (!p.folded)
      this.transaction(() => {
        p.folded = true;
        p.shown = false;
      });
  }
  command(cmd: Command): Result {
    // Viewing an invitation never rotates credentials or changes the current hand.
    if (cmd?.action === 'invite') return this.invitation(cmd.playerId ?? '');
    if (!cmd || cmd.revision !== this.state.revision)
      throw new Error('Стол уже изменился. Проверьте состояние и повторите действие.');
    return this.transaction(() => {
      const s = this.state;
      const between = () => {
        if (s.stage !== 'waiting')
          throw new Error('Изменять состав можно между раздачами. Сначала завершите текущую.');
      };
      const player = () => {
        const p = s.players.find((p) => p.id === cmd.playerId);
        if (!p) throw new Error('Игрок не найден');
        return p;
      };
      const nextDealer = (after: number) => {
        const next = [...s.players.slice(after + 1), ...s.players.slice(0, after + 1)].find(
          (p) => !p.eliminated,
        );
        s.dealerId = next?.id ?? null;
        s.dealerPending = !!next;
      };
      switch (cmd.action) {
        case 'blindPresetDelete': {
          const index = s.blindPresets.findIndex((preset) => preset.id === cmd.blindPresetId);
          if (index < 0) throw new Error('Набор блайндов не найден');
          s.blindPresets.splice(index, 1);
          return { ok: true };
        }
        case 'playerPresetDelete': {
          const index = s.playerPresets.findIndex((preset) => preset.id === cmd.playerPresetId);
          if (index < 0) throw new Error('Состав не найден');
          s.playerPresets.splice(index, 1);
          return { ok: true };
        }
        case 'playerPresetSave': {
          const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
          if (!name || name.length > 40) throw new Error('Название состава: от 1 до 40 символов');
          if (!s.players.length) throw new Error('Добавьте игроков перед сохранением состава');
          const existing = s.playerPresets.find(
            (preset) => preset.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'),
          );
          if (!existing && s.playerPresets.length >= 50)
            throw new Error('Можно сохранить до 50 составов');
          const preset = {
            id: existing?.id ?? randomUUID(),
            name,
            players: s.players.map((p) => p.name),
          };
          if (existing) s.playerPresets[s.playerPresets.indexOf(existing)] = preset;
          else s.playerPresets.push(preset);
          return { ok: true };
        }
        case 'blindPresetSave': {
          const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
          if (!name || name.length > 40) throw new Error('Название набора: от 1 до 40 символов.');
          if (!cmd.blindSettings || !validSettings(cmd.blindSettings))
            throw new Error('Проверьте время и уровни блайндов.');
          const existing = s.blindPresets.find(
            (p) => p.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'),
          );
          if (!existing && s.blindPresets.length >= 50)
            throw new Error('Можно сохранить до 50 наборов. Обновите существующий набор.');
          const preset: BlindPreset = {
            id: existing?.id ?? randomUUID(),
            name,
            minutes: cmd.blindSettings.minutes,
            levels: cmd.blindSettings.levels.map(({ small, big }) => ({ small, big })),
          };
          if (existing) s.blindPresets[s.blindPresets.indexOf(existing)] = preset;
          else s.blindPresets.push(preset);
          return { ok: true };
        }
        case 'blindSettings': {
          if (!cmd.blindSettings || !validSettings(cmd.blindSettings))
            throw new Error(
              'Укажите время 1–180 минут и 1–40 уровней с возрастающим большим блайндом.',
            );
          const settings = cmd.blindSettings;
          const b = s.blinds;
          const started =
            s.hand > 0 || b.running || b.level > 0 || b.remainingMs !== b.minutes * 60000;
          if (cmd.blindLevel !== undefined && cmd.blindLevel !== b.level)
            throw new Error('Уровень уже изменился. Закройте и снова откройте настройки.');
          if (
            started &&
            (settings.levels.length <= b.level ||
              b.levels.some(
                (row, index) =>
                  index <= b.level &&
                  (row.small !== settings.levels[index]?.small ||
                    row.big !== settings.levels[index]?.big),
              ))
          )
            throw new Error('Можно изменять и удалять только уровни после текущего.');
          s.blinds = {
            ...s.blinds,
            enabled: settings.enabled,
            minutes: settings.minutes,
            levels: settings.levels.map(({ small, big }) => ({ small, big })),
          };
          if (!started) s.blinds.remainingMs = settings.minutes * 60000;
          return { ok: true };
        }
        case 'blindRemove': {
          const index = cmd.blindLevel;
          if (
            !Number.isInteger(index) ||
            index! <= s.blinds.level ||
            index! >= s.blinds.levels.length
          )
            throw new Error('Можно удалить только будущий уровень.');
          s.blinds.levels.splice(index!, 1);
          return { ok: true };
        }
        case 'blindStart': {
          const b = s.blinds;
          if (b.running) throw new Error('Таймер уже запущен');
          if (b.awaitingDeal) throw new Error('Таймер запустится при следующей раздаче карт.');
          if (b.remainingMs <= 0) b.remainingMs = b.minutes * 60000;
          b.running = true;
          b.endsAt = this.now() + b.remainingMs;
          return { ok: true };
        }
        case 'blindPause': {
          const b = s.blinds;
          if (!b.running) throw new Error('Таймер уже на паузе');
          b.remainingMs = Math.max(0, b.endsAt! - this.now());
          b.endsAt = null;
          b.running = false;
          return { ok: true };
        }
        case 'blindPrevious':
        case 'blindNext': {
          const b = s.blinds;
          const direction = cmd.action === 'blindNext' ? 1 : -1;
          if (b.level + direction < 0 || b.level + direction >= b.levels.length)
            throw new Error(direction > 0 ? 'Следующего уровня нет' : 'Предыдущего уровня нет');
          b.level += direction;
          if (b.remainingMs === 0) b.running = true;
          b.remainingMs = b.minutes * 60000;
          b.endsAt = b.running ? this.now() + b.remainingMs : null;
          return { ok: true };
        }
        case 'blindReset': {
          resetBlinds(s.blinds);
          return { ok: true };
        }
        case 'reorder': {
          between();
          const order = cmd.order;
          if (
            !Array.isArray(order) ||
            order.length !== s.players.length ||
            new Set(order).size !== order.length ||
            !order.every((id) => typeof id === 'string' && s.players.some((p) => p.id === id))
          ) {
            throw new Error('Некорректный порядок игроков. Обновите список и повторите.');
          }
          const playersById = new Map(s.players.map((p) => [p.id, p]));
          s.players = order.map((id) => playersById.get(id)!);
          return { ok: true };
        }
        case 'add': {
          between();
          const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
          if (!name || name.length > 24)
            throw new Error('Имя должно содержать от 1 до 24 символов');
          if (s.players.length >= 10) throw new Error('Максимум 10 игроков');
          if (s.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
            throw new Error('Такое имя уже занято');
          let code = newCode();
          while (s.players.some((p) => p.codeHash === hash(code))) code = newCode();
          s.players.push({
            id: randomUUID(),
            name,
            codeHash: hash(code),
            token: null,
            cards: [],
            eliminated: false,
            rebuys: 0,
            shown: false,
            folded: false,
          });
          return {
            ...this.invitation(s.players[s.players.length - 1].id),
            code: code.slice(0, 5) + '-' + code.slice(5),
          };
        }
        case 'remove': {
          between();
          const p = player();
          const removedIndex = s.players.findIndex((v) => v.id === p.id);
          s.players = s.players.filter((v) => v.id !== p.id);
          if (s.dealerId === p.id) nextDealer(removedIndex - 1);
          return { ok: true };
        }
        case 'rebuyRemove': {
          const p = player();
          if (p.rebuys === 0) throw new Error('У игрока нет ребаев');
          p.rebuys--;
          return { ok: true };
        }
        case 'rebuy': {
          const p = player();
          if (p.rebuys >= Number.MAX_SAFE_INTEGER)
            throw new Error('Достигнут предел счётчика ребаев');
          p.rebuys++;
          return { ok: true };
        }
        case 'eliminate': {
          const p = player();
          p.eliminated = true;
          p.shown = false;
          if (s.dealerId === p.id) nextDealer(s.players.indexOf(p));
          return { ok: true };
        }
        case 'setDealer': {
          const p = player();
          if (p.eliminated) throw new Error('Игрок выбыл из турнира');
          s.dealerId = p.id;
          s.dealerPending = s.stage === 'waiting';
          return { ok: true };
        }
        case 'recode': {
          const p = player();
          let code = newCode();
          while (s.players.some((v) => v.codeHash === hash(code))) code = newCode();
          p.codeHash = hash(code);
          p.token = null;
          return { ...this.invitation(p.id), code: code.slice(0, 5) + '-' + code.slice(5) };
        }
        case 'deal': {
          if (s.stage !== 'waiting') throw new Error('Раздача уже идёт');
          const active = s.players.filter((p) => !p.eliminated);
          if (active.length < 2) throw new Error('Для раздачи нужны хотя бы два игрока в турнире');
          s.deck = shuffledDeck();
          s.burned = [];
          s.board = [];
          s.hand++;
          const previous = active.findIndex((p) => p.id === s.dealerId);
          const dealer = previous < 0 ? this.chooseDealer(active.length) : previous;
          s.dealerPending = false;
          s.dealerId = active[dealer].id;
          for (let round = 0; round < 2; round++)
            for (let offset = 1; offset <= active.length; offset++)
              active[(dealer + offset) % active.length].cards.push(s.deck.pop()!);
          s.stage = 'preflop';
          s.handBlinds = { ...s.blinds.levels[s.blinds.level] };
          if (!s.blinds.running && s.blinds.remainingMs > 0) {
            s.blinds.awaitingDeal = false;
            s.blinds.running = true;
            s.blinds.endsAt = this.now() + s.blinds.remainingMs;
          }
          return { ok: true };
        }
        case 'advance': {
          const next: Partial<Record<Stage, Stage>> = {
            preflop: 'flop',
            flop: 'turn',
            turn: 'river',
          };
          if (!next[s.stage]) throw new Error('Сейчас нельзя открыть следующую карту');
          const count = s.stage === 'preflop' ? 3 : 1;
          s.burned.push(s.deck.pop()!);
          for (let i = 0; i < count; i++) s.board.push(s.deck.pop()!);
          s.stage = next[s.stage]!;
          if (!s.blinds.running && !s.blinds.awaitingDeal && s.blinds.remainingMs > 0) {
            s.blinds.running = true;
            s.blinds.endsAt = this.now() + s.blinds.remainingMs;
          }
          return { ok: true };
        }
        case 'finish': {
          if (s.stage === 'waiting') throw new Error('Раздача ещё не началась');
          if (!s.dealerPending) nextDealer(s.players.findIndex((p) => p.id === s.dealerId));
          s.stage = 'waiting';
          s.handBlinds = null;
          s.board = [];
          s.deck = [];
          s.burned = [];
          s.players.forEach((p) => {
            p.cards = [];
            p.folded = false;
            p.shown = false;
          });
          return { ok: true };
        }
        case 'newTable':
        case 'newGame': {
          if (cmd.action === 'newTable') {
            const preset = s.playerPresets.find((p) => p.id === cmd.playerPresetId);
            if (cmd.playerPresetId && !preset)
              throw new Error('Состав не найден. Выберите его заново.');
            const usedCodes = new Set(s.players.map((p) => p.codeHash));
            s.players = (preset?.players ?? []).map((name) => {
              let codeHash = hash(newCode());
              while (usedCodes.has(codeHash)) codeHash = hash(newCode());
              usedCodes.add(codeHash);
              return {
                id: randomUUID(),
                name,
                codeHash,
                token: null,
                cards: [],
                eliminated: false,
                rebuys: 0,
                shown: false,
                folded: false,
              };
            });
          }
          if (cmd.randomSeating !== undefined && typeof cmd.randomSeating !== 'boolean')
            throw new Error('Некорректная настройка рассадки');
          if (cmd.blindPresetId !== undefined) {
            const preset = s.blindPresets.find((p) => p.id === cmd.blindPresetId);
            if (!preset) throw new Error('Набор блайндов не найден. Выберите его заново.');
            s.blinds = {
              ...s.blinds,
              enabled: true,
              minutes: preset.minutes,
              levels: preset.levels.map(({ small, big }) => ({ small, big })),
            };
          }
          resetBlinds(s.blinds);
          s.handBlinds = null;
          s.stage = 'waiting';
          s.board = [];
          s.deck = [];
          s.burned = [];
          s.hand = 0;
          if (cmd.randomSeating) {
            for (let i = s.players.length - 1; i > 0; i--) {
              const j = randomInt(i + 1);
              [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
            }
          }
          s.dealerId = s.players.length ? s.players[this.chooseDealer(s.players.length)].id : null;
          s.dealerPending = s.dealerId !== null;
          s.players.forEach((p) => {
            p.cards = [];
            p.folded = false;
            p.shown = false;
            p.eliminated = false;
            p.rebuys = 0;
          });
          return { ok: true };
        }
        case 'close': {
          resetBlinds(s.blinds);
          s.handBlinds = null;
          s.stage = 'waiting';
          s.board = [];
          s.deck = [];
          s.burned = [];
          s.players = [];
          s.dealerId = null;
          s.dealerPending = false;
          s.hand = 0;
          return { ok: true };
        }
        default:
          throw new Error('Неизвестная команда');
      }
    });
  }
  view(role: 'host' | 'player', token: string, online: Set<string>): TableView {
    const s = this.state;
    const self = role === 'player' ? this.playerByToken(token) : undefined;
    if (role === 'player' && !self) throw new Error('Доступ завершён');
    const shown = s.players.filter(
      (p) => p.shown && !p.folded && !p.eliminated && s.stage === 'river',
    );
    const hands = shown.map((p) => holdemHand([...s.board, ...p.cards]));
    const scores = hands.map((hand) => hand.score);
    const best = Math.max(...scores);
    return {
      revision: s.revision,
      hand: s.hand,
      stage: s.stage,
      board: [...s.board],
      dealerId: s.dealerId,
      dealerPending: s.dealerPending,
      blinds: structuredClone(s.blinds),
      handBlinds: s.handBlinds ? { ...s.handBlinds } : null,
      serverNow: this.now(),
      ...(role === 'host'
        ? {
            blindPresets: structuredClone(s.blindPresets),
            playerPresets: structuredClone(s.playerPresets),
          }
        : {}),
      role,
      ...(shown.length
        ? {
            winningCombination: combinationName(best),
            winningCards: Object.fromEntries(
              shown.flatMap((p, i) => (scores[i] === best ? [[p.id, hands[i].cards]] : [])),
            ),
            winnerIds: shown.filter((_, i) => scores[i] === best).map((p) => p.id),
          }
        : {}),
      players: s.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        seat: i + 1,
        online: online.has(p.id),
        eliminated: p.eliminated,
        rebuys: p.rebuys,
        folded: !!p.folded,
        inHand: !p.eliminated && !p.folded && p.cards.length > 0,
        ...(p.shown ? { shownCards: [...p.cards] } : {}),
      })),
      ...(self ? { selfId: self.id, cards: self.eliminated ? [] : [...self.cards] } : {}),
    };
  }
}
