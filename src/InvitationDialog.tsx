import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { invitationLink } from './invitation';

export function InvitationDialog({
  invitation,
  hostKey,
  hostPath,
  addresses,
  networkReady,
  addressIndex,
  onAddressChange,
  onClose,
  onReset,
}: {
  invitation?: { name: string; invitation: string; code?: string };
  hostKey?: string;
  hostPath?: string;
  addresses: { url: string }[];
  networkReady: boolean;
  addressIndex: number;
  onAddressChange: (index: number) => void;
  onClose: () => void;
  onReset?: () => void;
}) {
  const base = (addresses[addressIndex] ?? addresses[0])?.url ?? location.origin;
  const isHost = hostKey !== undefined;
  const link = isHost
    ? new URL(hostPath ?? '/host#' + hostKey, base).href
    : invitationLink(base, invitation!.invitation);
  const title = isHost ? 'Ведущий на другом устройстве' : invitation!.name;
  const [qr, setQr] = useState<{ link: string; image: string } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [qrError, setQrError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!networkReady) return;
    let active = true;
    setFeedback('');
    setQrError('');
    QRCode.toDataURL(link, {
      width: 280,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#102822', light: '#ffffff' },
    })
      .then((image) => {
        if (active) setQr({ link, image });
      })
      .catch(() => {
        if (active) setQrError('Не удалось создать QR-код. Используйте ссылку ниже.');
      });
    return () => {
      active = false;
    };
  }, [link, networkReady]);
  useEffect(() => {
    const original = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button, textarea, select') ?? []),
      ].filter((e) => !e.hasAttribute('disabled'));
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      original?.focus();
    };
  }, []);
  async function copyLink() {
    if (!networkReady) return;
    setFeedback('');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(link);
        setFeedback('Ссылка скопирована');
        return;
      } catch {
        /* Local HTTP or browser policy: use selection-based copying below. */
      }
    }
    input.current?.focus();
    input.current?.select();
    try {
      if (document.execCommand('copy')) {
        setFeedback('Ссылка скопирована');
        return;
      }
    } catch {
      /* Keep text selected. */
    }
    setFeedback('Ссылка выделена. Нажмите Ctrl+C или выберите «Копировать».');
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal invitation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
      >
        <div className="invitation-heading">
          <span className="eyebrow">{isHost ? 'ПАНЕЛЬ ВЕДУЩЕГО' : 'ЛИЧНОЕ ПРИГЛАШЕНИЕ'}</span>
          <button className="icon-button" onClick={onClose} aria-label="Закрыть приглашение">
            ×
          </button>
        </div>
        <h2 id="invite-title">{title}</h2>
        <p>
          {isHost
            ? 'Отсканируйте QR-код планшетом или откройте ссылку — панель ведущего откроется сразу. Подключите планшет к той же Wi-Fi сети, что и ноутбук.'
            : 'Отсканируйте QR-код или откройте ссылку — вход на ваше место произойдёт автоматически.'}
        </p>
        {addresses.length > 1 && (
          <select
            aria-label="Сеть для персонального приглашения"
            value={addressIndex}
            onChange={(e) => onAddressChange(Number(e.target.value))}
          >
            {addresses.map((a, i) => (
              <option key={a.url} value={i}>
                {a.url}
              </option>
            ))}
          </select>
        )}
        <div className="personal-qr">
          {networkReady && qr?.link === link ? (
            <img
              src={qr.image}
              alt={isHost ? 'QR-код панели ведущего' : 'Персональный QR-код: ' + title}
              width="224"
              height="224"
            />
          ) : (
            <p role="status">
              {!networkReady ? 'Определяем адрес сети…' : qrError || 'Готовим QR-код…'}
            </p>
          )}
        </div>
        <label className="invite-link-label" htmlFor="invite-link">
          {isHost ? 'Ссылка панели ведущего' : 'Ссылка для входа с компьютера'}
        </label>
        <textarea
          ref={input}
          id="invite-link"
          className="invite-link"
          value={networkReady ? link : ''}
          readOnly
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="primary wide" onClick={copyLink} disabled={!networkReady}>
          Копировать ссылку <span aria-hidden="true">↗</span>
        </button>
        <div className="copy-feedback" role="status">
          {feedback}
        </div>
        <p className="tiny">
          {isHost
            ? 'Ноутбук с сервером должен оставаться включённым. Управлять можно с обоих устройств — изменения появятся одновременно.'
            : 'Передайте приглашение только этому игроку. На другом устройстве оно восстановит его карты и заменит прежнее подключение.'}
        </p>
        {networkReady && !addresses.length && (
          <p className="tiny">
            Локальная сеть не найдена. Этот адрес может быть доступен только на ноутбуке.
          </p>
        )}
        {invitation?.code && (
          <details>
            <summary>Код для ручного входа</summary>
            <div className="manual-code">{invitation.code}</div>
          </details>
        )}
        <div className="invitation-actions">
          {onReset && (
            <button className="text-button danger" onClick={onReset}>
              Заменить доступ
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            Готово
          </button>
        </div>
      </section>
    </div>
  );
}
