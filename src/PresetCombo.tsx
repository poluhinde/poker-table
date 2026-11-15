import { useRef, useState } from 'react';
type NamedPreset = { id: string; name: string; players?: string[] };

export function PresetCombo<T extends NamedPreset>({
  presets,
  value,
  onChange,
  onDelete,
  disabled,
  id = 'player-preset',
  label = 'Название состава',
  listLabel = 'Сохранённые составы',
  deleteLabel = 'Удалить состав',
}: {
  presets: T[];
  value: string;
  onChange: (value: string) => void;
  onDelete: (preset: T) => void;
  disabled: boolean;
  id?: string;
  label?: string;
  listLabel?: string;
  deleteLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const selected = presets.find(
    (preset) => preset.name.toLocaleLowerCase('ru-RU') === value.trim().toLocaleLowerCase('ru-RU'),
  );
  const choose = (preset: T) => {
    onChange(preset.name);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };
  return (
    <>
      <label htmlFor={`${id}-name`}>{label}</label>
      <div
        className="preset-combo-row"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <div className="preset-combo">
          <div className="preset-combo-field">
            <input
              ref={input}
              id={`${id}-name`}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={`${id}-options`}
              aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
              autoComplete="off"
              value={value}
              maxLength={40}
              disabled={disabled}
              onChange={(event) => {
                onChange(event.target.value);
                setActive(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  return;
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setOpen(true);
                  const direction = event.key === 'ArrowDown' ? 1 : -1;
                  setActive((index) =>
                    presets.length ? (index + direction + presets.length) % presets.length : -1,
                  );
                } else if (event.key === 'Enter' && open && presets[active]) {
                  event.preventDefault();
                  choose(presets[active]);
                }
              }}
            />
            <button
              type="button"
              className="preset-combo-toggle"
              aria-label={`Показать: ${listLabel}`}
              disabled={disabled}
              onClick={() => {
                setOpen(!open);
                setActive(-1);
                input.current?.focus();
              }}
            >
              {open ? '▴' : '▾'}
            </button>
          </div>
          {open && (
            <ul
              id={`${id}-options`}
              role="listbox"
              aria-label={listLabel}
              className="preset-combo-options"
            >
              {presets.map((preset, index) => (
                <li
                  key={preset.id}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={selected?.id === preset.id}
                  className={index === active ? 'active' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(preset)}
                >
                  {preset.name}
                </li>
              ))}
              {!presets.length && <li className="tiny">Список пока пуст</li>}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          title={deleteLabel}
          aria-label={`${deleteLabel}${selected ? ` ${selected.name}` : ''}`}
          disabled={disabled || !selected}
          onClick={() => {
            setOpen(false);
            if (selected) onDelete(selected);
          }}
        >
          ×
        </button>
      </div>
      {selected?.players && <p className="tiny">{selected.players.join(', ')}</p>}
    </>
  );
}
