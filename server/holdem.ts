import type { Card } from '../shared/types.js';

const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function scoreFive(cards: Card[]): number {
  const values = cards.map((card) => ranks.indexOf(card.slice(0, -1)) + 2).sort((a, b) => b - a);
  const groups = [...new Set(values)]
    .map((rank) => ({ rank, count: values.filter((value) => value === rank).length }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const [first, second] = groups;
  const flush = cards.every((card) => card.at(-1) === cards[0].at(-1));
  const straight =
    groups.length === 5 &&
    (values[0] - values[4] === 4 ? values[0] : values.join(',') === '14,5,4,3,2' ? 5 : 0);
  const category =
    flush && straight
      ? 8
      : first.count === 4
        ? 7
        : first.count === 3 && second.count === 2
          ? 6
          : flush
            ? 5
            : straight
              ? 4
              : first.count === 3
                ? 3
                : second.count === 2
                  ? 2
                  : first.count === 2
                    ? 1
                    : 0;
  const kickers = straight ? [straight] : groups.map(({ rank }) => rank);
  return Array.from({ length: 5 }, (_, i) => kickers[i] ?? 0).reduce(
    (score, rank) => score * 15 + rank,
    category,
  );
}

export function holdemHand(cards: Card[]): { score: number; cards: Card[] } {
  let best = 0;
  let bestCards: Card[] = [];
  // Each five-card subset of the seven cards excludes exactly two cards.
  for (let i = 0; i < cards.length - 1; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const candidate = cards.filter((_, index) => index !== i && index !== j);
      const score = scoreFive(candidate);
      if (score > best) {
        best = score;
        bestCards = candidate;
      }
    }
  }
  return { score: best, cards: bestCards };
}

export function holdemScore(cards: Card[]): number {
  return holdemHand(cards).score;
}

export function combinationName(score: number): string {
  return [
    'Старшая карта',
    'Пара',
    'Две пары',
    'Сет / тройка',
    'Стрит',
    'Флеш',
    'Фулл-хаус',
    'Каре',
    'Стрит-флеш',
  ][Math.floor(score / 15 ** 5)];
}
