export type Card = string;
export type Stage = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river';
export interface BlindLevel {
  small: number;
  big: number;
}
export interface BlindSettings {
  enabled: boolean;
  minutes: number;
  levels: BlindLevel[];
}
export interface BlindPreset {
  id: string;
  name: string;
  minutes: number;
  levels: BlindLevel[];
}
export interface PlayerPreset {
  id: string;
  name: string;
  players: string[];
}
export interface BlindClock extends BlindSettings {
  alarmId: number;
  awaitingDeal: boolean;
  level: number;
  running: boolean;
  endsAt: number | null;
  remainingMs: number;
}
export interface PlayerView {
  id: string;
  name: string;
  seat: number;
  online: boolean;
  inHand: boolean;
  eliminated: boolean;
  rebuys: number;
  folded?: boolean;
  shownCards?: Card[];
}
export interface TableView {
  revision: number;
  hand: number;
  stage: Stage;
  board: Card[];
  players: PlayerView[];
  winnerIds?: string[];
  winningCombination?: string;
  winningCards?: Record<string, Card[]>;
  dealerId: string | null;
  dealerPending: boolean;
  blinds: BlindClock;
  handBlinds: BlindLevel | null;
  serverNow: number;
  blindPresets?: BlindPreset[];
  playerPresets?: PlayerPreset[];
  role: 'host' | 'player';
  selfId?: string;
  cards?: Card[];
}
export type Action =
  | 'blindSettings'
  | 'blindPresetSave'
  | 'blindPresetDelete'
  | 'blindRemove'
  | 'blindStart'
  | 'blindPause'
  | 'blindNext'
  | 'blindPrevious'
  | 'blindReset'
  | 'reorder'
  | 'invite'
  | 'add'
  | 'remove'
  | 'eliminate'
  | 'rebuy'
  | 'rebuyRemove'
  | 'setDealer'
  | 'recode'
  | 'deal'
  | 'advance'
  | 'finish'
  | 'newGame'
  | 'newTable'
  | 'playerPresetSave'
  | 'playerPresetDelete'
  | 'close';
export interface Command {
  action: Action;
  revision: number;
  name?: string;
  playerId?: string;
  order?: string[];
  blindSettings?: BlindSettings;
  blindLevel?: number;
  blindPresetId?: string;
  randomSeating?: boolean;
  playerPresetId?: string;
}
export interface Result {
  ok: boolean;
  error?: string;
  code?: string;
  invitation?: string;
  playerId?: string;
  name?: string;
}
export const STAGES: Record<Stage, string> = {
  waiting: 'Ожидание раздачи',
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Тёрн',
  river: 'Ривер',
};
