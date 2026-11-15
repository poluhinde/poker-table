import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Action, BlindSettings, BlindPreset, Command, TableView } from '../shared/types';
import { PresetCombo } from './PresetCombo';

type Send = (action: Action, extra?: Partial<Command>, done?: (ok: boolean) => void) => void;
const amount = (n: number) => n.toLocaleString('ru-RU');

export function BlindControls({
  table,
  connected,
  canAct,
  send,
  onDeletePreset,
}: {
  table: TableView;
  connected: boolean;
  canAct: boolean;
  send?: Send;
  onDeletePreset: (preset: BlindPreset) => void;
}) {
  const b = table.blinds;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BlindSettings>(() => structuredClone(b));
  const [draftLevel, setDraftLevel] = useState(b.level);
  const [presetName, setPresetName] = useState('');
  const [presetSaved, setPresetSaved] = useState('');
  const existingPreset = table.blindPresets?.find(
    (p) => p.name.toLocaleLowerCase('ru-RU') === presetName.trim().toLocaleLowerCase('ru-RU'),
  );
  const draftInitialized = useRef(false);
  const [now, setNow] = useState(table.serverNow);
  const [sound, setSound] = useState(true);
  const [alarmOpen, setAlarmOpen] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const previousAlarm = useRef<number | null>(null);
  useEffect(() => {
    const receivedAt = performance.now();
    const update = () => setNow(table.serverNow + performance.now() - receivedAt);
    update();
    const interval = window.setInterval(update, 250);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [table.serverNow]);
  useEffect(() => {
    if (!send || !sound) return;
    const prepare = () => {
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume().catch(() => {});
      } catch {
        /* The popup remains available if audio is unavailable. */
      }
    };
    document.addEventListener('pointerdown', prepare);
    document.addEventListener('keydown', prepare);
    return () => {
      document.removeEventListener('pointerdown', prepare);
      document.removeEventListener('keydown', prepare);
    };
  }, [sound, send]);
  useEffect(() => {
    if (!send || !connected) return;
    const newAlarm = previousAlarm.current !== null && b.alarmId > previousAlarm.current;
    const missedAlarm =
      previousAlarm.current === null &&
      b.alarmId > 0 &&
      !b.running &&
      (b.remainingMs === 0 || b.awaitingDeal);
    previousAlarm.current = b.alarmId;
    if (b.alarmId === 0) {
      setAlarmOpen(false);
      return;
    }
    if (!newAlarm && !missedAlarm) return;
    setAlarmOpen(true);
    if (sound && audio.current?.state === 'running') {
      const context = audio.current;
      for (let i = 0; i < 3; i++) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.connect(gain);
        gain.connect(context.destination);
        const start = context.currentTime + i * 0.3;
        oscillator.frequency.value = i === 1 ? 880 : 660;
        gain.gain.setValueAtTime(0.15, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
        oscillator.start(start);
        oscillator.stop(start + 0.22);
      }
    }
  }, [b.alarmId, b.running, b.remainingMs, b.awaitingDeal, sound, connected, send]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );

  const left = Math.max(0, b.running && b.endsAt !== null ? b.endsAt - now : b.remainingMs);
  const seconds = Math.ceil(left / 1000);
  const time =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const scheduled = b.levels[b.level];
  const current = table.handBlinds ?? scheduled;
  const pending =
    !!table.handBlinds && (current.small !== scheduled.small || current.big !== scheduled.big);
  const next = pending ? scheduled : b.levels[b.level + 1];
  const finished = !b.running && b.remainingMs === 0;
  const changed =
    draft.enabled !== b.enabled ||
    draft.minutes !== b.minutes ||
    draft.levels.length !== b.levels.length ||
    draft.levels.some(
      (row, index) => row.small !== b.levels[index]?.small || row.big !== b.levels[index]?.big,
    );
  const valid =
    Number.isInteger(draft.minutes) &&
    draft.minutes >= 1 &&
    draft.minutes <= 180 &&
    draft.levels.length > 0 &&
    draft.levels.every(
      (level, i) =>
        Number.isSafeInteger(level.small) &&
        level.small > 0 &&
        level.small <= 1e9 &&
        Number.isSafeInteger(level.big) &&
        level.big >= level.small &&
        level.big <= 1e9 &&
        (i === 0 ||
          (level.small >= draft.levels[i - 1].small && level.big > draft.levels[i - 1].big)),
    );
  const started = table.hand > 0 || b.running || b.level > 0 || b.remainingMs !== b.minutes * 60000;
  function openSettings() {
    if (!draftInitialized.current || draftLevel !== b.level) {
      setDraft({ enabled: b.enabled, minutes: b.minutes, levels: structuredClone(b.levels) });
      setDraftLevel(b.level);
      draftInitialized.current = true;
    }
    setEditing(!editing);
  }
  const settingsAllowed = canAct && draftLevel === b.level;
  return (
    <>
      <section
        className={'blind-timer ' + (b.running && seconds <= 60 ? 'ending' : '')}
        aria-label="Блайнды и таймер"
      >
        <div className="blind-heading">
          <span className="eyebrow">БЛАЙНДЫ И ТАЙМЕР</span>
          {send && (
            <button
              className="text-button"
              onClick={openSettings}
              aria-expanded={editing}
              aria-controls="blind-level-editor"
              title="Показать или скрыть настройки уровней"
            >
              Уровни {editing ? '▴' : '▾'}
            </button>
          )}
        </div>
        <>
          {!send && (
            <div className="blind-readout">
              <div>
                <span className="tiny">
                  {table.handBlinds ? 'Блайнды этой раздачи' : 'Малый / большой блайнд'}
                </span>
                <strong className="blind-amount">
                  {amount(current.small)} / {amount(current.big)}
                </strong>
              </div>
              <div className="blind-countdown">
                <span className="tiny">
                  Уровень {b.level + 1} / {b.levels.length}
                </span>
                <strong role="timer" aria-label="Осталось времени на уровне">
                  {time}
                </strong>
              </div>
            </div>
          )}
          <div className="blind-status" role="status">
            {!connected
              ? 'Нет связи · ждём синхронизации'
              : b.awaitingDeal
                ? 'Таймер ждёт следующую раздачу'
                : finished
                  ? b.enabled
                    ? 'Структура завершена · последние блайнды сохраняются'
                    : 'Время истекло · переключите блайнды вручную'
                  : b.running
                    ? seconds === 0
                      ? 'Обновляем уровень…'
                      : 'До конца уровня'
                    : 'Таймер на паузе'}
            {next && (
              <span>
                {pending ? 'Со следующей раздачи: ' : 'Следующие: '}
                {amount(next.small)} / {amount(next.big)}
              </span>
            )}
          </div>
          {send && (
            <div className="blind-controls">
              <button
                className="secondary"
                disabled={!canAct || b.level === 0}
                aria-label="Предыдущий уровень"
                title="Предыдущий уровень"
                onClick={() => send('blindPrevious')}
              >
                ← Предыдущий
              </button>
              <button
                className="secondary"
                disabled={!canAct || b.level === b.levels.length - 1}
                aria-label="Следующий уровень"
                title="Следующий уровень"
                onClick={() => send('blindNext')}
              >
                Следующий →
              </button>
              <button
                className="text-button"
                aria-pressed={sound}
                onClick={() => {
                  if (!sound) {
                    try {
                      audio.current ??= new AudioContext();
                      void audio.current.resume().catch(() => setSound(false));
                      setSound(true);
                    } catch {
                      setSound(false);
                    }
                  } else setSound(false);
                }}
              >
                {sound ? 'Звук вкл.' : 'Звук выкл.'}
              </button>
            </div>
          )}
        </>

        {editing && send && (
          <form
            className="blind-editor"
            id="blind-level-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (changed && valid && settingsAllowed)
                send('blindSettings', { blindSettings: draft, blindLevel: draftLevel }, (ok) => {
                  if (ok) {
                    setEditing(false);
                    draftInitialized.current = false;
                  }
                });
            }}
          >
            <fieldset disabled={!settingsAllowed}>
              <legend className="eyebrow">НАСТРОЙКИ БЛАЙНДОВ</legend>
              <label className="blind-enable">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />{' '}
                Автоматическое повышение
              </label>
              <label className="blind-duration">
                Длительность уровня, мин
                <input
                  type="number"
                  min="1"
                  max="180"
                  required
                  value={draft.minutes || ''}
                  onChange={(event) => setDraft({ ...draft, minutes: Number(event.target.value) })}
                />
              </label>
              <div className="blind-presets">
                {[5, 10, 15, 20, 30].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="secondary"
                    aria-pressed={draft.minutes === minutes}
                    onClick={() => setDraft({ ...draft, minutes })}
                  >
                    {minutes} мин
                  </button>
                ))}
              </div>
              <div className="blind-levels">
                <table>
                  <thead>
                    <tr>
                      <th>Уровень</th>
                      <th>Малый</th>
                      <th>Большой</th>
                      <th>
                        <span className="sr-only">Удалить</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.levels.map((row, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        {(['small', 'big'] as const).map((key) => (
                          <td key={key}>
                            <input
                              type="number"
                              min="1"
                              max="1000000000"
                              required
                              disabled={started && i <= b.level}
                              aria-label={`${key === 'small' ? 'Малый' : 'Большой'} блайнд уровня ${i + 1}`}
                              value={row[key] || ''}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  levels: draft.levels.map((level, index) =>
                                    index === i
                                      ? { ...level, [key]: Number(event.target.value) }
                                      : level,
                                  ),
                                })
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`Удалить уровень ${i + 1}`}
                            disabled={draft.levels.length === 1 || (started && i <= b.level)}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                levels: draft.levels.filter((_, index) => index !== i),
                              })
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                className="secondary"
                type="button"
                disabled={draft.levels.length >= 40}
                onClick={() => {
                  const last = draft.levels[draft.levels.length - 1];
                  setDraft({
                    ...draft,
                    levels: [...draft.levels, { small: last.big, big: last.big * 2 }],
                  });
                }}
              >
                ＋ Добавить уровень
              </button>
            </fieldset>
            <p className="tiny">
              {started
                ? 'Текущий и прошедшие уровни заблокированы. Изменения применяются к будущим уровням; таймер продолжает отсчёт. Новая длительность действует со следующего уровня.'
                : 'Укажите длительность и размеры блайндов. Таймер запустится при раздаче карт.'}
            </p>
            {!valid && (
              <p className="blind-validation" role="alert">
                Проверьте длительность и размеры блайндов: положительные целые числа, большой не
                меньше малого, уровни идут по возрастанию.
              </p>
            )}
            {!settingsAllowed && (
              <p className="blind-validation" role="alert">
                Уровень изменился или нет связи. Закройте и снова откройте настройки после
                подключения.
              </p>
            )}
            <div className="blind-editor-actions">
              <button className="primary" disabled={!changed || !valid || !settingsAllowed}>
                Применить к игре
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(false);
                  draftInitialized.current = false;
                }}
              >
                Отмена
              </button>
            </div>
            <div className="blind-preset-save">
              <PresetCombo
                id="blind-preset"
                label="Сохранить набор для новой игры"
                listLabel="Наборы блайндов"
                deleteLabel="Удалить набор"
                presets={table.blindPresets ?? []}
                value={presetName}
                disabled={!canAct}
                onChange={(name) => {
                  setPresetName(name);
                  setPresetSaved('');
                }}
                onDelete={onDeletePreset}
              />
              <button
                type="button"
                className="secondary"
                disabled={!canAct || !valid || !presetName.trim()}
                onClick={() =>
                  send(
                    'blindPresetSave',
                    { name: presetName.trim(), blindSettings: draft },
                    (ok) => {
                      if (ok)
                        setPresetSaved(
                          `Набор «${presetName.trim()}» сохранён. Выберите его при новой игре.`,
                        );
                    },
                  )
                }
              >
                {existingPreset ? 'Обновить набор' : 'Сохранить набор'}
              </button>
              {existingPreset && !presetSaved && (
                <p className="tiny">Сохранённый набор с этим именем будет обновлён.</p>
              )}
              {presetSaved && (
                <p className="tiny" role="status">
                  {presetSaved}
                </p>
              )}
            </div>
          </form>
        )}
      </section>
      {send && alarmOpen && (
        <BlindAlarmDialog
          table={table}
          canAct={canAct}
          send={send}
          onClose={() => setAlarmOpen(false)}
        />
      )}
    </>
  );
}

function BlindAlarmDialog({
  table,
  canAct,
  send,
  onClose,
}: {
  table: TableView;
  canAct: boolean;
  send: Send;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const b = table.blinds;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current!;
    root.querySelector<HTMLButtonElement>('button')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    root.addEventListener('keydown', keys);
    return () => {
      root.removeEventListener('keydown', keys);
      previous?.focus();
    };
  }, []);
  const level = b.levels[b.level];
  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal blind-alarm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="blind-alarm-title"
        aria-describedby="blind-alarm-description"
      >
        <span className="eyebrow">БЛАЙНДЫ И ТАЙМЕР</span>
        <h2 id="blind-alarm-title">Время уровня истекло</h2>
        <p id="blind-alarm-description">
          {b.enabled
            ? b.awaitingDeal || b.running
              ? `Выбран уровень ${b.level + 1}: ${amount(level.small)} / ${amount(level.big)}. Таймер запустится при следующей раздаче карт.`
              : 'Последний уровень завершён. Блайнды остаются прежними.'
            : 'Блайнды остаются прежними. Переключите уровень вручную или повторите отсчёт.'}
        </p>
        {table.handBlinds && (
          <p className="tiny">Текущая раздача доигрывается с прежними блайндами.</p>
        )}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Закрыть
          </button>
          {!b.running && !b.awaitingDeal && (
            <button
              className="secondary"
              disabled={!canAct}
              onClick={() =>
                send('blindStart', {}, (ok) => {
                  if (ok) onClose();
                })
              }
            >
              Повторить таймер
            </button>
          )}
          {!b.enabled && b.level < b.levels.length - 1 && (
            <button
              className="primary"
              disabled={!canAct}
              onClick={() =>
                send('blindNext', {}, (ok) => {
                  if (ok) onClose();
                })
              }
            >
              Следующий уровень
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function BlindTimer(props: Omit<Parameters<typeof BlindControls>[0], 'onDeletePreset'>) {
  return <TableBlindClock {...props} />;
}

function TableBlindClock({
  table,
  connected,
  canAct,
  send,
}: Omit<Parameters<typeof BlindControls>[0], 'onDeletePreset'>) {
  const b = table.blinds;
  const [now, setNow] = useState(table.serverNow);
  useEffect(() => {
    const receivedAt = performance.now();
    const update = () => setNow(table.serverNow + performance.now() - receivedAt);
    update();
    const interval = window.setInterval(update, 250);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [table.serverNow]);
  const seconds = Math.ceil(
    Math.max(0, b.running && b.endsAt !== null ? b.endsAt - now : b.remainingMs) / 1000,
  );
  const time =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const scheduled = b.levels[b.level];
  const current = table.handBlinds ?? scheduled;
  const pending = current.small !== scheduled.small || current.big !== scheduled.big;
  const finished = !b.running && b.remainingMs === 0;
  return (
    <section
      className={
        (send ? 'blind-table-strip' : 'blind-table-strip player-blind-strip') +
        (b.running && seconds <= 60 ? ' ending' : '')
      }
      aria-label="Блайнды и таймер"
    >
      <span
        className="blind-strip-values"
        title={table.handBlinds ? 'Блайнды этой раздачи' : 'Малый / большой блайнд'}
      >
        Блайнды{' '}
        <strong>
          {amount(current.small)} / {amount(current.big)}
        </strong>
      </span>
      <span
        className="blind-strip-time"
        title={
          !connected
            ? 'Нет связи · ждём синхронизации'
            : finished
              ? 'Время уровня истекло'
              : `Уровень ${b.level + 1} · ${b.running ? 'до повышения' : 'пауза'}`
        }
      >
        <strong role="timer" aria-label="Осталось времени на уровне">
          {time}
        </strong>
      </span>
      {send && (
        <button
          className="blind-strip-toggle"
          disabled={!canAct || b.awaitingDeal}
          onClick={() => send?.(b.running ? 'blindPause' : 'blindStart')}
          aria-label={
            b.running ? 'Пауза таймера' : finished ? 'Повторить таймер' : 'Запустить таймер'
          }
          title={
            b.awaitingDeal
              ? 'Запустится при следующей раздаче'
              : b.running
                ? 'Пауза'
                : finished
                  ? 'Повторить таймер'
                  : 'Запустить'
          }
        >
          {b.running ? 'Ⅱ' : '▶'}
        </button>
      )}
      {pending && (
        <span className="blind-strip-pending" role="status">
          Со следующей раздачи: {amount(scheduled.small)} / {amount(scheduled.big)}
        </span>
      )}
      {!connected && (
        <span className="blind-strip-pending" role="status">
          Нет связи
        </span>
      )}
    </section>
  );
}
