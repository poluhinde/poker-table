import { useState } from 'react';
import type { PlayerView } from '../shared/types';

export function DealerChip({
  players,
  dealerId,
  pending,
  onMove,
}: {
  players: PlayerView[];
  dealerId: string | null;
  pending: boolean;
  onMove?: (id: string) => void;
}) {
  const [offset, setOffset] = useState<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const index = players.findIndex((p) => p.id === dealerId);
  if (index < 0) return null;
  const angle = (index / Math.max(players.length, 1)) * Math.PI * 2 - Math.PI / 2;
  const x = 50 + 43 * Math.cos(angle),
    y = 50 + 43 * Math.sin(angle);
  const label = (pending ? 'Следующий дилер: ' : 'Дилер: ') + players[index].name;
  return (
    <button
      type="button"
      className={'dealer-chip' + (offset ? ' moving' : '')}
      disabled={!onMove}
      aria-label={label}
      title={onMove ? label + '. Перетащите к игроку или используйте стрелки.' : label}
      onPointerDown={(e) => {
        if (!onMove || e.button !== 0 || !e.isPrimary) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setOffset({ x: 0, y: 0, startX: e.clientX, startY: e.clientY });
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setOffset(
          (start) =>
            start && { ...start, x: e.clientX - start.startX, y: e.clientY - start.startY },
        );
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const table = e.currentTarget.closest('.poker-table');
        const seat = document
          .elementsFromPoint(e.clientX, e.clientY)
          .map((element) => element.closest<HTMLElement>('[data-dealer-seat]'))
          .find((element) => element && table?.contains(element));
        const id = seat?.dataset.dealerSeat;
        setOffset(null);
        if (id && id !== dealerId) onMove?.(id);
      }}
      onLostPointerCapture={() => setOffset(null)}
      onKeyDown={(e) => {
        const direction = ['ArrowRight', 'ArrowDown'].includes(e.key)
          ? 1
          : ['ArrowLeft', 'ArrowUp'].includes(e.key)
            ? -1
            : 0;
        if (!onMove || !direction || players.length < 2) return;
        e.preventDefault();
        onMove(players[(index + direction + players.length) % players.length].id);
      }}
      style={{
        left: 'calc(' + x + '% ' + (x >= 50 ? '-' : '+') + ' 37px)',
        top: 'calc(' + y + '% - 16px)',
        ...(offset ? { translate: `${offset.x}px ${offset.y}px` } : {}),
      }}
    >
      <span aria-hidden="true">
        <b>D</b>
        <small>DEALER</small>
      </span>
    </button>
  );
}
