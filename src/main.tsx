import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { STAGES, type TableView, type Action, type Result, type Command } from '../shared/types';
import { InvitationDialog } from './InvitationDialog';
import { useSeatOrder } from './useSeatOrder';
import { DealerChip } from './DealerChip';
import { PresetCombo } from './PresetCombo';
import { BlindTimer, BlindControls } from './BlindTimer';
import { cardFace } from './cardFaces';
import './style.css';
const isHost = location.pathname === '/host',
  storageKey = isHost ? 'poker.host' : 'poker.player';
if (isHost && location.hash.length > 1) {
  localStorage.setItem(storageKey, location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
}
// Pasting another invitation into this tab can be a fragment-only navigation.
window.addEventListener('hashchange', () => {
  const newInvitation = !isHost && new URLSearchParams(location.hash.slice(1)).has('invite');
  const newHostKey = isHost && /^#[a-f0-9]{64}$/.test(location.hash);
  if (newInvitation || newHostKey) location.reload();
});
const initialInvitation = !isHost
  ? new URLSearchParams(location.hash.slice(1)).get('invite')
  : null;
if (initialInvitation !== null) history.replaceState(null, '', location.pathname + location.search);
let invitationRequest: Promise<{ token: string }> | null = null;
function redeemInvitation() {
  return fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invitation: initialInvitation,
      token: localStorage.getItem(storageKey),
    }),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Не удалось войти по ссылке');
    return result as { token: string };
  });
}
const symbols: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
function Card({
  value,
  open = true,
  animate = false,
  index = 0,
  small = false,
  boardSlot = false,
  winning = false,
}: {
  value?: string;
  open?: boolean;
  animate?: boolean;
  index?: number;
  small?: boolean;
  boardSlot?: boolean;
  winning?: boolean;
}) {
  const suit = value?.slice(-1) ?? 'S',
    rank = value?.slice(0, -1) ?? '';
  return (
    <div
      role="img"
      className={
        'card ' +
        (small ? 'small ' : '') +
        (animate ? 'motion ' : '') +
        (value && open ? 'revealed' : '') +
        (winning ? ' winning-card' : '')
      }
      style={{ '--i': index } as React.CSSProperties}
      aria-label={
        value && open
          ? rank + ' ' + symbols[suit]
          : boardSlot
            ? 'Пустое место для общей карты'
            : 'Закрытая карта'
      }
    >
      <div className="card-inner" aria-hidden="true">
        <div className={boardSlot ? 'card-back board-slot' : 'card-back'}>
          {!boardSlot && <span>♠</span>}
        </div>
        {value && open && (
          <div className="card-front">
            <img className="card-art" src={cardFace(value)} alt="" draggable={false} />
          </div>
        )}
      </div>
    </div>
  );
}
function cardsToLift(cards: string[] = [], combination: string[] = []): string[] {
  const selected = cards.filter((card) => combination.includes(card));
  return selected.length < cards.length ? selected : [];
}
function App() {
  const [token, setToken] = useState(() =>
      initialInvitation !== null ? '' : (localStorage.getItem(storageKey) ?? ''),
    ),
    [table, setTable] = useState<TableView | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [holding, setHolding] = useState(false),
    [motion, setMotion] = useState(false),
    [dealMotion, setDealMotion] = useState(false);
  const [autoJoin, setAutoJoin] = useState(initialInvitation !== null);
  const [invitation, setInvitation] = useState<{
    name: string;
    invitation: string;
    playerId: string;
    code?: string;
  } | null>(null);
  useEffect(() => {
    if (!autoJoin || initialInvitation === null) return;
    let active = true;
    // Share the request across StrictMode effect replay: no duplicate session creation.
    invitationRequest ??= redeemInvitation();
    invitationRequest
      .then((result) => {
        if (!active) return;
        localStorage.setItem(storageKey, result.token);
        setToken(result.token);
        setAutoJoin(false);
        setError('');
      })
      .catch((e) => {
        if (!active) return;
        setAutoJoin(false);
        setError(e instanceof Error ? e.message : 'Нет связи с сервером');
      });
    return () => {
      active = false;
    };
  }, [autoJoin]);
  const [confirm, setConfirm] = useState<{
    action: Action | 'showCards';
    hand?: number;
    playerId?: string;
    playerPresetId?: string;
    blindPresetId?: string;
    title: string;
    description: string;
  } | null>(null);
  const [hostPath, setHostPath] = useState<string>();
  const [newGamePreset, setNewGamePreset] = useState('');
  const [playerPresetName, setPlayerPresetName] = useState('');
  const [playerPresetId, setPlayerPresetId] = useState('');
  const [rosterSaved, setRosterSaved] = useState(false);
  const [randomSeating, setRandomSeating] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  useEffect(() => {
    const update = (event: KeyboardEvent) => setCtrlHeld(event.ctrlKey);
    const reset = () => setCtrlHeld(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);
  const [hostShare, setHostShare] = useState(false);
  const [tableFocus, setTableFocus] = useState(false);
  const [riverResultReady, setRiverResultReady] = useState(false);
  useEffect(() => {
    setRiverResultReady(false);
    if (table?.stage !== 'river') return;
    // Fifth card: 280 ms stagger + 580 ms flip, then 500 ms to see the river.
    const timeout = window.setTimeout(() => setRiverResultReady(true), 1360);
    return () => window.clearTimeout(timeout);
  }, [table?.hand, table?.stage]);
  const [networkReady, setNetworkReady] = useState(false);
  const [addresses, setAddresses] = useState<{ url: string }[]>([]),
    [addressIndex, setAddressIndex] = useState(0);
  const socketRef = useRef<Socket | null>(null),
    prior = useRef<TableView | null>(null);
  useEffect(() => {
    const hide = () => setHolding(false);
    document.addEventListener('visibilitychange', hide);
    const events = ['blur', 'pointerup', 'pointercancel', 'keyup'] as const;
    events.forEach((e) => window.addEventListener(e, hide));
    return () => {
      document.removeEventListener('visibilitychange', hide);
      events.forEach((e) => window.removeEventListener(e, hide));
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    const socket = io({
      auth: { role: isHost ? 'host' : 'player', token },
      reconnectionDelay: 700,
      reconnectionDelayMax: 3000,
    });
    socketRef.current = socket;
    const clear = () => {
      localStorage.removeItem(storageKey);
      setToken('');
      setTable(null);
      setHolding(false);
      setConnected(false);
      setError('Доступ завершён. Введите актуальный код или обратитесь к ведущему.');
    };
    socket.on('connect', () => {
      setConnected(true);
      setError('');
      if (isHost)
        fetch('/api/host-info', { headers: { Authorization: 'Bearer ' + token } })
          .then((r) => r.json())
          .then((v) => {
            if (v.addresses) setAddresses(v.addresses);
            if (v.hostPath) setHostPath(v.hostPath);
            setNetworkReady(true);
          })
          .catch(() => {
            setNetworkReady(true);
            setError('Не удалось получить адрес подключения');
          });
    });
    socket.on('state', (value: TableView) => {
      const previous = prior.current;
      setDealMotion(!!previous && value.hand !== previous.hand && value.stage === 'preflop');
      setMotion(!!previous && (value.hand !== previous.hand || value.stage !== previous.stage));
      if (!previous || value.hand !== previous.hand || value.stage === 'waiting') setHolding(false);
      prior.current = value;
      setTable(value);
    });
    socket.on('disconnect', () => {
      setConnected(false);
      setHolding(false);
      prior.current = null;
    });
    socket.on('connect_error', (e) => {
      setConnected(false);
      if (e.message === 'AUTH') {
        socket.disconnect();
        clear();
      }
    });
    socket.on('revoked', () => {
      socket.disconnect();
      clear();
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      prior.current = null;
    };
  }, [token]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Не удалось войти');
      localStorage.setItem(storageKey, result.token);
      setToken(result.token);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }
  function command(action: Action, extra: Partial<Command> = {}, done?: (ok: boolean) => void) {
    if (!table || !connected || busy) {
      done?.(false);
      return;
    }
    setBusy(true);
    setError('');
    socketRef
      .current!.timeout(6000)
      .emit(
        'command',
        { action, revision: table.revision, ...extra },
        (err: Error | null, result: Result) => {
          setBusy(false);
          done?.(!err && !!result?.ok);
          if (err) {
            setError('Ответ не получен. Проверьте состояние стола перед повтором.');
            return;
          }
          if (!result.ok) {
            setConfirm(null);
            setError(result.error ?? 'Не удалось выполнить действие');
            return;
          }
          setConfirm(null);
          if (action === 'blindPresetDelete' && newGamePreset === extra.blindPresetId) {
            setNewGamePreset('');
          }
          if (action === 'playerPresetDelete') {
            setPlayerPresetName('');
            setRosterSaved(false);
            if (playerPresetId === extra.playerPresetId) setPlayerPresetId('');
          }
          if (result.invitation) {
            setInvitation({
              name: result.name!,
              invitation: result.invitation,
              playerId: result.playerId!,
              code: result.code,
            });
            setName('');
          }
        },
      );
  }
  const seats = useSeatOrder(
    table,
    isHost && connected && !busy && table?.stage === 'waiting',
    (order, revision, done) => command('reorder', { order, revision }, done),
  );
  const self = table?.players.find((p) => p.id === table.selfId),
    activeSeats = seats.players.filter((p) => !p.eliminated),
    activePlayers = table?.players.filter((p) => !p.eliminated) ?? [],
    visibleWinnerIds = riverResultReady && table?.stage === 'river' ? table.winnerIds : undefined,
    visibleWinningCards =
      riverResultReady && table?.stage === 'river' ? table.winningCards : undefined,
    raisedBoardCards = cardsToLift(table?.board, Object.values(visibleWinningCards ?? {}).flat()),
    raisedPlayerCards = Object.fromEntries(
      (table?.players ?? []).map((player) => [
        player.id,
        cardsToLift(player.shownCards, visibleWinningCards?.[player.id]),
      ]),
    ),
    winners = table?.players.filter((p) => visibleWinnerIds?.includes(p.id)) ?? [],
    winnerLabel = `${winners.length > 1 ? 'Победители' : 'Победитель'}: ${winners.map((p) => p.name).join(', ')}. Комбинация: ${table?.winningCombination ?? ''}.`,
    canAct = connected && !busy && !seats.dragging,
    stage = table?.stage ?? 'waiting',
    chosen = addresses[addressIndex] ?? addresses[0];
  const board = () => (
    <div className="board">
      {Array.from({ length: 5 }, (_, i) => (
        <Card
          key={(table?.hand ?? 0) + '-' + i}
          value={table?.board[i]}
          index={i}
          animate={motion}
          boardSlot
          winning={isHost && raisedBoardCards.includes(table?.board[i] ?? '')}
        />
      ))}
    </div>
  );
  return (
    <div
      className={
        'app ' +
        (isHost ? 'host-app' : 'player-app') +
        (isHost && table && tableFocus ? ' table-focus' : '')
      }
    >
      {(isHost || !table) && (
        <header className="topbar">
          <a className="brand" href="/">
            <span className="brand-mark">♠</span>
            <span>
              за столом<small>POKER COMPANION</small>
            </span>
          </a>
          <div className="header-right">
            <span className={'connection ' + (connected ? 'live' : '')}>
              <i />
              {connected ? 'На связи' : token ? 'Подключение…' : 'Локальный стол'}
            </span>
            {isHost && (
              <button
                className="role-tag host-share-button"
                onClick={() => setHostShare(true)}
                disabled={!table}
                title="QR-код и ссылка для входа ведущего с другого устройства"
                aria-haspopup="dialog"
              >
                ВЕДУЩИЙ
              </button>
            )}
          </div>
        </header>
      )}
      {error && (
        <div className="message error" role="alert">
          {error}
          <button aria-label="Закрыть сообщение" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {autoJoin ? (
        <main className="loading">
          <div className="spinner" />
          <h2>Входим по личной ссылке</h2>
          <p>Сейчас откроется ваше место за столом.</p>
        </main>
      ) : !token ? (
        <main className="login-layout">
          <section className="login-art">
            <div className="eyebrow">ЖИВЫЕ ЛЮДИ. НАСТОЯЩИЙ СТОЛ.</div>
            <h1>
              Карты — здесь.
              <br />
              <em>
                Всё остальное —<br />
                между вами.
              </em>
            </h1>
            <div className="hero-cards">
              <Card value="AS" />
              <Card value="KH" />
              <Card value="QC" />
            </div>
            <p>
              Без ставок и подсчёта очков.
              <br />
              Просто ваша колода на ваших устройствах.
            </p>
          </section>
          <section className="login-panel">
            <span className="eyebrow">{isHost ? 'ПАНЕЛЬ ВЕДУЩЕГО' : 'ВАШЕ МЕСТО ЗА СТОЛОМ'}</span>
            <h2>{isHost ? 'Откройте стол с ноутбука' : 'Присоединиться'}</h2>
            {isHost ? (
              <p>
                Запустите <strong>Start Poker.cmd</strong> в папке проекта. Он откроет панель с
                ключом ведущего.
              </p>
            ) : (
              <>
                <p>
                  Введите личный код от ведущего.
                  <br />
                  Ваши карты увидите только вы.
                </p>
                {initialInvitation !== null && (
                  <button
                    className="secondary wide"
                    onClick={() => {
                      invitationRequest = null;
                      setError('');
                      setAutoJoin(true);
                    }}
                  >
                    Повторить вход по ссылке
                  </button>
                )}
                <form onSubmit={login}>
                  <label htmlFor="code">Код игрока</label>
                  <input
                    id="code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="ABCDE-23456"
                    maxLength={24}
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                  />
                  <button className="primary wide" disabled={busy || !code.trim()}>
                    {busy ? 'Подключаемся…' : 'Занять место'}
                    <span>↗</span>
                  </button>
                </form>
                <div className="subtle-note">
                  Уже играли? Введите тот же код — текущая раздача сохранится.
                </div>
              </>
            )}
          </section>
        </main>
      ) : !table ? (
        <main className="loading">
          <div className="spinner" />
          <h2>Подключаемся к столу</h2>
          <p>Проверьте, что сервер работает и вы в одной Wi-Fi сети.</p>
        </main>
      ) : isHost ? (
        <main className="host-layout">
          <section className="game-panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">ТЕХАССКИЙ ХОЛДЕМ · ДО 10 ИГРОКОВ</div>
                <h1>Ваш вечер. Ваш стол.</h1>
              </div>
              <div className="table-view-actions">
                <span className="hand-badge">
                  Раздача <b>{String(table.hand).padStart(2, '0')}</b>
                </span>
                <button
                  className="secondary table-view-toggle"
                  aria-pressed={tableFocus}
                  onClick={() => setTableFocus((value) => !value)}
                >
                  {tableFocus ? '↙ Полный вид' : '⛶ Только стол'}
                </button>
              </div>
            </div>
            <div
              className={'poker-table ' + (dealMotion ? 'animate-deal' : '')}
              style={
                {
                  '--seat-bottom-gap':
                    (Math.max(
                      0,
                      ...activeSeats.map(
                        (_, i) =>
                          50 + 43 * Math.sin((i / activeSeats.length) * Math.PI * 2 - Math.PI / 2),
                      ),
                    ) -
                      100) /
                      1.45 +
                    '%',
                } as React.CSSProperties
              }
            >
              <div className="felt-ring" />
              <BlindTimer table={table} connected={connected} canAct={canAct} send={command} />
              <DealerChip
                players={activeSeats}
                dealerId={table.dealerId}
                pending={table.dealerPending}
                onMove={
                  canAct && activeSeats.length > 1
                    ? (playerId) => command('setDealer', { playerId })
                    : undefined
                }
              />
              <div className="table-center">
                <div className="table-wordmark">
                  ЗА СТОЛОМ <span>♠</span>
                </div>
                {board()}
                <div className="stage-pill">{STAGES[stage]}</div>
                <div
                  className={winners.length ? 'table-caption winner-result' : 'table-caption'}
                  aria-live="polite"
                >
                  {winners.length
                    ? winnerLabel
                    : stage === 'waiting'
                      ? 'Пусть вечер начнётся'
                      : stage === 'river'
                        ? 'Все карты на столе. Решение за вами.'
                        : 'Общие карты открывает ведущий'}
                </div>
              </div>
              {activeSeats.map((p, i) => {
                const angle = (i / Math.max(activeSeats.length, 1)) * Math.PI * 2 - Math.PI / 2,
                  x = 50 + 43 * Math.cos(angle),
                  y = 50 + 43 * Math.sin(angle);
                return (
                  <div
                    key={p.id}
                    data-dealer-seat={p.id}
                    className={
                      'seat ' +
                      (!p.online ? 'offline' : '') +
                      (p.inHand ? ' active-seat' : ' inactive-seat') +
                      (visibleWinnerIds?.includes(p.id)
                        ? ' winning-seat'
                        : p.shownCards && winners.length
                          ? ' losing-hand'
                          : '')
                    }
                    style={
                      {
                        left: x + '%',
                        top: y + '%',
                        '--dx': 50 - x + 'cqw',
                        '--dy': (50 - y) * 0.6 + 'cqw',
                        '--delay': i * 90 + 'ms',
                        '--card-x': -9 * Math.cos(angle) + 'cqw',
                        '--card-y': (-12 * Math.sin(angle)) / 1.45 + 'cqw',
                      } as React.CSSProperties
                    }
                  >
                    {p.inHand && (
                      <div className="seat-cards" key={table.hand}>
                        <Card
                          small
                          value={p.shownCards?.[0]}
                          winning={raisedPlayerCards[p.id]?.includes(p.shownCards?.[0] ?? '')}
                        />
                        <Card
                          small
                          value={p.shownCards?.[1]}
                          winning={raisedPlayerCards[p.id]?.includes(p.shownCards?.[1] ?? '')}
                        />
                      </div>
                    )}
                    <div className="seat-avatar">{p.name.slice(0, 1).toUpperCase()}</div>
                    <div className="seat-name" title={p.name}>
                      {p.name}
                    </div>
                    <span className="seat-status">
                      <i />
                      {p.folded
                        ? 'Слил'
                        : p.inHand
                          ? 'В раздаче'
                          : p.online
                            ? 'За столом'
                            : 'Не в сети'}
                    </span>
                  </div>
                );
              })}
              {activeSeats.length === 0 && (
                <div className="empty-seat">
                  <span>＋</span>
                  {table.players.length
                    ? 'Все игроки выбыли'
                    : tableFocus
                      ? 'Добавьте игроков в полном виде'
                      : 'Добавьте игроков справа'}
                </div>
              )}
            </div>
            <div className="controls">
              <div>
                <span className="eyebrow">УПРАВЛЕНИЕ РАЗДАЧЕЙ</span>
                <p>
                  {stage === 'waiting'
                    ? 'Добавьте минимум двух игроков и раздайте карты.'
                    : stage === 'river'
                      ? 'Обсудите результат и завершите раздачу.'
                      : 'Ставки и решения остаются за вашим столом.'}
                </p>
              </div>
              <div className="control-buttons">
                {stage === 'waiting' ? (
                  <button
                    className="primary"
                    disabled={!canAct || activePlayers.length < 2}
                    onClick={() => command('deal')}
                  >
                    ♠ Раздать карты
                  </button>
                ) : (
                  <>
                    {stage !== 'river' && (
                      <button
                        className="primary"
                        disabled={!canAct}
                        onClick={() => command('advance')}
                      >
                        {stage === 'preflop'
                          ? 'Открыть флоп'
                          : stage === 'flop'
                            ? 'Открыть тёрн'
                            : 'Открыть ривер'}{' '}
                        →
                      </button>
                    )}
                    <button
                      className={stage === 'river' ? 'primary' : 'secondary'}
                      disabled={!canAct}
                      onClick={() =>
                        setConfirm({
                          action: 'finish',
                          title: 'Завершить раздачу?',
                          description:
                            'Личные и общие карты исчезнут у всех игроков. Следующую раздачу вы запустите отдельно.',
                        })
                      }
                    >
                      Завершить раздачу
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="footnote">
              <span>◈ Личные карты видны всем после открытия игроком</span>
              <span>
                {table.dealerId
                  ? (table.dealerPending ? 'Следующий дилер: ' : 'Дилер: ') +
                    table.players.find((p) => p.id === table.dealerId)?.name
                  : 'Первый дилер выбирается случайно'}
              </span>
            </div>
          </section>
          <aside className="sidebar">
            <section className="join-panel">
              <div className="eyebrow">ПРИГЛАСИТЕ КОМПАНИЮ</div>
              <h2>Все в одной сети</h2>
              <p>
                Подключите устройства к одной сети. У каждого игрока — свой QR-код и ссылка в списке
                ниже.
              </p>
              {chosen ? (
                <>
                  {addresses.length > 1 ? (
                    <select
                      aria-label="Адрес сети для игроков"
                      value={addressIndex}
                      onChange={(e) => setAddressIndex(Number(e.target.value))}
                    >
                      {addresses.map((a, i) => (
                        <option key={a.url} value={i}>
                          {a.url}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="local-address">{chosen.url}</div>
                  )}
                  <p className="tiny">
                    Нажмите «QR» рядом с именем, чтобы пригласить игрока без ввода кода.
                    {addresses.length > 1 ? ' Выберите адрес вашей Wi-Fi сети.' : ''}
                  </p>
                </>
              ) : (
                <p className="tiny">
                  Нет адреса сети. Подключите ноутбук к Wi-Fi и обновите страницу.
                </p>
              )}
            </section>
            <section className="players-panel">
              <div className="players-heading">
                <h2>Игроки</h2>
                <span>{table.players.length} / 10</span>
              </div>
              <p id="seat-help" className="tiny seat-help">
                {stage === 'waiting'
                  ? 'Потяните за ⠿ — места на столе изменятся сразу.'
                  : 'Перестановка мест доступна между раздачами.'}
              </p>
              <ol
                className={'player-list ' + (seats.dragging ? 'reordering' : '')}
                ref={seats.listRef}
                {...seats.listEvents}
                aria-label="Порядок посадки игроков"
              >
                {seats.players.map((p) => (
                  <li
                    key={p.id}
                    data-seat-row={p.id}
                    className={seats.dragging === p.id ? 'dragged-player' : ''}
                  >
                    <button
                      className="seat-handle"
                      type="button"
                      disabled={
                        !connected || busy || stage !== 'waiting' || table.players.length < 2
                      }
                      aria-label={'Переместить ' + p.name}
                      aria-describedby="seat-help"
                      title="Перетащить; с клавиатуры — стрелки вверх/вниз"
                      onPointerDown={(e) => seats.startDrag(e, p.id)}
                      onKeyDown={(e) => seats.keyboardMove(e, p.id)}
                    >
                      ⠿
                    </button>
                    <div>
                      <strong title={p.name}>
                        {p.name}
                        {table.dealerId === p.id && (
                          <span
                            className="dealer-tag"
                            title={table.dealerPending ? 'Следующий дилер' : 'Дилер'}
                          >
                            D
                          </span>
                        )}
                      </strong>
                      <small className={p.online && !p.eliminated ? 'online-text' : ''}>
                        {p.eliminated
                          ? 'Выбыл из турнира'
                          : p.online
                            ? 'Подключён'
                            : 'Ожидает подключения'}
                        {' · Ребаи: '}
                        {p.rebuys}
                      </small>
                    </div>
                    <button
                      className="icon-button"
                      title="QR-код и ссылка игрока"
                      aria-label={'QR и ссылка для ' + p.name}
                      disabled={!canAct}
                      onClick={() => command('invite', { playerId: p.id })}
                    >
                      QR
                    </button>
                    <button
                      className="icon-button"
                      title="Добавить ребай · Ctrl + клик — убрать"
                      aria-label={(ctrlHeld ? 'Убрать ребай: ' : 'Добавить ребай: ') + p.name}
                      disabled={!canAct || (ctrlHeld && p.rebuys === 0)}
                      onPointerEnter={(event) => setCtrlHeld(event.ctrlKey)}
                      onClick={(event) => {
                        if (event.ctrlKey && p.rebuys === 0) return;
                        command(event.ctrlKey ? 'rebuyRemove' : 'rebuy', { playerId: p.id });
                      }}
                    >
                      {ctrlHeld ? '−R' : '+R'}
                    </button>
                    <button
                      className="icon-button"
                      title="Отметить как выбывшего из турнира"
                      aria-label={'Отметить как выбывшего: ' + p.name}
                      disabled={!canAct || p.eliminated}
                      onClick={() =>
                        setConfirm({
                          action: 'eliminate',
                          playerId: p.id,
                          title: `${p.name} выбыл из турнира?`,
                          description:
                            'Игрок останется в списке и вернётся за стол при начале новой игры.',
                        })
                      }
                    >
                      ↗
                    </button>
                    <button
                      className="icon-button"
                      aria-label={'Удалить ' + p.name}
                      disabled={!canAct || stage !== 'waiting'}
                      onClick={() =>
                        setConfirm({
                          action: 'remove',
                          playerId: p.id,
                          title: 'Удалить ' + p.name + '?',
                          description: 'Игрок потеряет доступ к столу.',
                        })
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
              <div className="sr-only" role="status" aria-live="polite">
                {seats.announcement}
              </div>
              {!table.players.length && (
                <p className="empty-list">Пока никого. Первое место свободно.</p>
              )}
              <form
                className="add-player"
                onSubmit={(e) => {
                  e.preventDefault();
                  command('add', { name });
                }}
              >
                <label className="sr-only" htmlFor="name">
                  Имя игрока
                </label>
                <input
                  id="name"
                  placeholder="Имя игрока"
                  maxLength={24}
                  value={name}
                  disabled={stage !== 'waiting' || table.players.length >= 10}
                  onChange={(e) => setName(e.target.value)}
                />
                <button
                  className="add-button"
                  aria-label="Добавить игрока"
                  disabled={
                    !canAct || !name.trim() || stage !== 'waiting' || table.players.length >= 10
                  }
                >
                  ＋
                </button>
              </form>
              <p className="tiny">
                {stage !== 'waiting'
                  ? 'Состав можно менять между раздачами.'
                  : 'Порядок сохраняется после отпускания. На клавиатуре — стрелки ↑ и ↓.'}
              </p>
            </section>
            <section className="players-panel">
              <details className="player-presets">
                <summary className="eyebrow">СОСТАВЫ ИГРОКОВ</summary>
                <form
                  className="new-game-presets"
                  onSubmit={(event) => {
                    event.preventDefault();
                    command('playerPresetSave', { name: playerPresetName }, (ok) =>
                      setRosterSaved(ok),
                    );
                  }}
                >
                  <PresetCombo
                    presets={table.playerPresets ?? []}
                    value={playerPresetName}
                    disabled={!canAct}
                    onChange={(name) => {
                      setPlayerPresetName(name);
                      setRosterSaved(false);
                    }}
                    onDelete={(preset) =>
                      setConfirm({
                        action: 'playerPresetDelete',
                        playerPresetId: preset.id,
                        title: `Удалить состав «${preset.name}»?`,
                        description: 'Сохранённый состав будет удалён из списка.',
                      })
                    }
                  />
                  <button
                    className="secondary"
                    disabled={!canAct || !table.players.length || !playerPresetName.trim()}
                  >
                    Сохранить текущий состав
                  </button>
                  <p className="tiny">
                    Сохраняются имена и порядок всех игроков. Повторное сохранение с тем же
                    названием обновляет состав.
                  </p>
                  {rosterSaved && (
                    <p className="tiny" role="status">
                      Состав сохранён
                    </p>
                  )}
                </form>
              </details>
            </section>
            <BlindControls
              table={table}
              connected={connected}
              canAct={canAct}
              send={command}
              onDeletePreset={(preset) =>
                setConfirm({
                  action: 'blindPresetDelete',
                  blindPresetId: preset.id,
                  title: `Удалить набор «${preset.name}»?`,
                  description: 'Сохранённый набор блайндов будет удалён из списка.',
                })
              }
            />
            <div className="table-actions" aria-label="Управление игрой">
              <button
                className="secondary"
                disabled={!canAct}
                onClick={() =>
                  setConfirm({
                    action: 'newGame',
                    title: 'Начать новую игру?',
                    description:
                      'Карты и счётчик раздач будут сброшены. Таймер остановится на первом уровне блайндов. Игроки, настройки и QR-ссылки сохранятся. Первый дилер выбирается случайно.',
                  })
                }
              >
                Новая игра
              </button>
              <button
                className="secondary"
                disabled={!canAct}
                onClick={() =>
                  setConfirm({
                    action: 'newTable',
                    title: 'Новый стол',
                    description:
                      'Начнётся новый стол с выбранным составом. Карты, раздачи, ребаи и таймер будут сброшены. Игрокам понадобятся новые QR-ссылки.',
                  })
                }
              >
                Новый стол
              </button>
            </div>
          </aside>
        </main>
      ) : (
        <main className="player-layout">
          <section className="personal-hand">
            {self?.inHand && (
              <button
                className="secondary"
                disabled={!connected || busy}
                onClick={() => {
                  setBusy(true);
                  socketRef.current
                    ?.timeout(6000)
                    .emit('fold', table.hand, (err: Error | null, result: Result) => {
                      setBusy(false);
                      if (err || !result?.ok)
                        setError(result?.error ?? 'Не удалось сбросить карты');
                    });
                }}
              >
                Слить
              </button>
            )}
            {self?.folded && <p>Вы сбросили карты</p>}
            <button
              type="button"
              className={
                'hand-cards ' + (dealMotion ? 'deal-in' : '') + (self?.folded ? ' folded-hand' : '')
              }
              key={table.hand}
              aria-label="Удерживайте карты, чтобы посмотреть"
              aria-pressed={holding}
              disabled={!connected || !table.cards?.length}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setHolding(true);
              }}
              onPointerUp={() => setHolding(false)}
              onPointerCancel={() => setHolding(false)}
              onLostPointerCapture={() => setHolding(false)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  setHolding(true);
                }
              }}
              onKeyUp={() => setHolding(false)}
              onBlur={() => setHolding(false)}
            >
              {[0, 1].map((i) => (
                <Card
                  key={i}
                  value={table.cards?.[i]}
                  open={!!self?.shownCards || (holding && connected)}
                  animate
                  index={i}
                />
              ))}
            </button>
            {!table.cards?.length && !self?.folded && (
              <h2>{self?.eliminated ? 'Вы выбыли из турнира' : 'Ваше место за столом готово'}</h2>
            )}
          </section>
          <section className="player-board">
            <div className="players-heading">
              <h2>На столе</h2>
              <span>
                {STAGES[stage]} · {table.board.length} / 5
              </span>
            </div>
            {board()}
            <BlindTimer table={table} connected={connected} canAct={false} />
            {!!winners.length && (
              <p className="winner-result" aria-live="polite">
                {winnerLabel}
              </p>
            )}
          </section>
          {stage !== 'waiting' && !self?.folded && !!table.cards?.length && (
            <button
              className="secondary reveal-cards-button"
              disabled={!connected || busy || !!self?.shownCards}
              onClick={() =>
                setConfirm({
                  action: 'showCards',
                  hand: table.hand,
                  title: 'Открыть карты всем?',
                  description: 'Ваши карты увидят ведущий и остальные игроки до конца раздачи.',
                })
              }
            >
              {self?.shownCards ? 'Карты открыты' : 'Открыть карты всем'}
            </button>
          )}
        </main>
      )}
      {isHost && table && hostShare && (
        <InvitationDialog
          hostKey={token}
          hostPath={hostPath}
          addresses={addresses}
          networkReady={networkReady}
          addressIndex={addressIndex}
          onAddressChange={setAddressIndex}
          onClose={() => setHostShare(false)}
        />
      )}
      {invitation && (
        <InvitationDialog
          invitation={invitation}
          addresses={addresses}
          networkReady={networkReady}
          addressIndex={addressIndex}
          onAddressChange={setAddressIndex}
          onClose={() => setInvitation(null)}
          onReset={() => {
            setConfirm({
              action: 'recode',
              playerId: invitation.playerId,
              title: 'Заменить доступ для ' + invitation.name + '?',
              description: 'Прежние QR-код, ссылка и код перестанут работать. Карты сохранятся.',
            });
            setInvitation(null);
          }}
        />
      )}
      {confirm && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h2 id="confirm-title">{confirm.title}</h2>
            <p>{confirm.description}</p>
            {(confirm.action === 'newGame' || confirm.action === 'newTable') && table && (
              <div className="new-game-presets">
                {confirm.action === 'newTable' && (
                  <>
                    <label htmlFor="new-table-roster">Состав игроков</label>
                    <select
                      id="new-table-roster"
                      value={playerPresetId}
                      disabled={busy}
                      onChange={(event) => setPlayerPresetId(event.target.value)}
                    >
                      <option value="">Пустой стол — добавлю игроков вручную</option>
                      {(table.playerPresets ?? []).map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    {playerPresetId && (
                      <p className="tiny">
                        {table.playerPresets
                          ?.find((preset) => preset.id === playerPresetId)
                          ?.players.join(', ')}
                      </p>
                    )}
                  </>
                )}

                <label className="blind-enable">
                  <input
                    type="checkbox"
                    checked={randomSeating}
                    disabled={busy}
                    onChange={(event) => setRandomSeating(event.target.checked)}
                  />
                  Случайная рассадка
                </label>
                <label htmlFor="new-game-preset">Набор блайндов</label>
                <select
                  id="new-game-preset"
                  value={newGamePreset}
                  disabled={busy}
                  onChange={(event) => setNewGamePreset(event.target.value)}
                >
                  <option value="">Текущие настройки</option>
                  {(table.blindPresets ?? []).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                {(() => {
                  const preset = table.blindPresets?.find((p) => p.id === newGamePreset);
                  const settings = preset ?? table.blinds;
                  return (
                    <p className="tiny">
                      {settings.minutes} мин · {settings.levels.length} уровней · начало{' '}
                      {settings.levels[0].small} / {settings.levels[0].big}
                    </p>
                  );
                })()}
                {!table.blindPresets?.length && (
                  <p className="tiny">Сохраните свой набор в настройках уровней блайндов.</p>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button
                autoFocus
                className="secondary"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Отмена
              </button>
              <button
                className="primary"
                disabled={!canAct}
                onClick={() => {
                  if (confirm.action === 'showCards') {
                    setBusy(true);
                    setError('');
                    socketRef.current
                      ?.timeout(6000)
                      .emit('showCards', confirm.hand, (err: Error | null, result: Result) => {
                        setBusy(false);
                        setConfirm(null);
                        if (err || !result?.ok)
                          setError(result?.error ?? 'Не удалось открыть карты');
                      });
                    return;
                  }
                  command(confirm.action, {
                    playerId: confirm.playerId,
                    ...(confirm.action === 'blindPresetDelete'
                      ? { blindPresetId: confirm.blindPresetId }
                      : {}),
                    ...(confirm.action === 'playerPresetDelete'
                      ? { playerPresetId: confirm.playerPresetId }
                      : {}),
                    ...(['newGame', 'newTable'].includes(confirm.action) ? { randomSeating } : {}),
                    ...(confirm.action === 'newTable' ? { playerPresetId } : {}),
                    ...(['newGame', 'newTable'].includes(confirm.action) && newGamePreset
                      ? { blindPresetId: newGamePreset }
                      : {}),
                  });
                }}
              >
                {busy ? 'Выполняем…' : 'Подтвердить'}
              </button>
            </div>
          </section>
        </div>
      )}
      <footer>
        ЗА СТОЛОМ <span>♠</span>{' '}
        {!isHost && self ? `· ${self.name}` : 'Раздаём карты. Остальное — за вами.'}
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
