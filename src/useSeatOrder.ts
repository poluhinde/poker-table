import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { TableView } from '../shared/types';

export function moveSeat(order: string[], id: string, target: number): string[] {
  const from = order.indexOf(id);
  if (from < 0 || target < 0 || target >= order.length || from === target) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

type Drag = {
  id: string;
  pointer: number;
  revision: number;
  original: string[];
  order: string[];
  y: number;
};
export function useSeatOrder(
  table: TableView | null,
  enabled: boolean,
  commit: (order: string[], revision: number, done: (ok: boolean) => void) => void,
) {
  const listRef = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const source = table?.players ?? [];
  const validDraft =
    draft && draft.length === source.length && draft.every((id) => source.some((p) => p.id === id));
  const players = validDraft
    ? draft!.map((id, i) => ({ ...source.find((p) => p.id === id)!, seat: i + 1 }))
    : source;

  function release() {
    const active = drag.current;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setDragging(null);
    if (active && listRef.current?.hasPointerCapture(active.pointer)) {
      listRef.current.releasePointerCapture(active.pointer);
    }
    return active;
  }
  function cancel() {
    if (!drag.current) return;
    release();
    setDraft(null);
    setAnnouncement('Перестановка отменена');
  }
  useEffect(() => {
    if (drag.current && (!enabled || table?.revision !== drag.current.revision)) cancel();
  }, [enabled, table?.revision]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        cancel();
      }
    };
    const blur = () => cancel();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  function moveAt(y: number) {
    const active = drag.current;
    if (!active || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>('[data-seat-row]')];
    let target = 0,
      distance = Infinity;
    rows.forEach((row, i) => {
      const rect = row.getBoundingClientRect();
      const delta = Math.abs(y - (rect.top + rect.bottom) / 2);
      if (delta < distance) {
        distance = delta;
        target = i;
      }
    });
    const next = moveSeat(active.order, active.id, target);
    if (next !== active.order) {
      active.order = next;
      setDraft(next);
      setAnnouncement('Новое место: ' + (target + 1));
    }
  }
  function autoScroll() {
    const active = drag.current,
      list = listRef.current;
    if (!active || !list) return;
    const bounds = list.getBoundingClientRect();
    const before = list.scrollTop;
    if (active.y < bounds.top + 28) list.scrollTop -= 7;
    else if (active.y > bounds.bottom - 28) list.scrollTop += 7;
    if (before !== list.scrollTop) moveAt(active.y);
    frame.current = requestAnimationFrame(autoScroll);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (
      !enabled ||
      !table ||
      table.players.length < 2 ||
      event.button !== 0 ||
      !event.isPrimary ||
      drag.current
    )
      return;
    event.preventDefault();
    const original = table.players.map((p) => p.id);
    drag.current = {
      id,
      pointer: event.pointerId,
      revision: table.revision,
      original,
      order: original,
      y: event.clientY,
    };
    setDraft(original);
    setDragging(id);
    listRef.current?.setPointerCapture(event.pointerId);
    frame.current = requestAnimationFrame(autoScroll);
  }
  function finish(event: PointerEvent<HTMLOListElement>) {
    if (!drag.current || event.pointerId !== drag.current.pointer) return;
    moveAt(event.clientY);
    const active = release()!;
    if (active.order.every((id, i) => id === active.original[i])) {
      setDraft(null);
      return;
    }
    setAnnouncement('Сохраняем порядок игроков');
    commit(active.order, active.revision, (ok) => {
      setDraft(null);
      setAnnouncement(ok ? 'Порядок игроков обновлён' : 'Не удалось сохранить порядок игроков');
    });
  }
  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (!enabled || !table || drag.current) return;
    const order = table.players.map((p) => p.id),
      from = order.indexOf(id);
    const targets: Record<string, number> = {
      ArrowUp: from - 1,
      ArrowDown: from + 1,
      Home: 0,
      End: order.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const next = moveSeat(order, id, targets[event.key]);
    if (next === order) return;
    const handle = event.currentTarget;
    setDraft(next);
    commit(next, table.revision, (ok) => {
      setDraft(null);
      setAnnouncement(ok ? 'Порядок игроков обновлён' : 'Не удалось сохранить порядок игроков');
      requestAnimationFrame(() => handle.focus());
    });
  }
  return {
    players,
    listRef,
    dragging,
    announcement,
    startDrag,
    keyboardMove,
    listEvents: {
      onPointerMove(event: PointerEvent<HTMLOListElement>) {
        if (!drag.current || event.pointerId !== drag.current.pointer) return;
        drag.current.y = event.clientY;
        moveAt(event.clientY);
      },
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    },
  };
}
