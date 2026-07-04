'use client';

import { STEM_META, STEM_NAMES, type StemName } from '@prismaxim/shared';

export interface StemPickerProps {
  value: StemName[];
  onChange: (stems: StemName[]) => void;
  /** disable interaction (e.g. while a job is running) */
  disabled?: boolean;
}

/**
 * Toggle grid for choosing which of the 6 stems to separate. Zero selected is a
 * valid state — it means "no separation, keep the original track" (handled by
 * the caller). The emitted list is always in canonical STEM_NAMES order,
 * regardless of click order.
 */
export default function StemPicker({ value, onChange, disabled }: StemPickerProps) {
  const selected = new Set(value);
  const allOn = value.length === STEM_NAMES.length;
  const noneOn = value.length === 0;

  const toggle = (name: StemName) => {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(STEM_NAMES.filter((n) => next.has(n)));
  };

  return (
    <div className="stem-picker">
      <div className="stem-grid">
        {STEM_NAMES.map((name) => {
          const on = selected.has(name);
          const { label, color } = STEM_META[name];
          return (
            <button
              key={name}
              type="button"
              className={`stem-chip${on ? ' active' : ''}`}
              onClick={() => toggle(name)}
              disabled={disabled}
              aria-pressed={on}
              style={on ? { borderColor: color } : undefined}
            >
              <span className="stem-dot" style={{ background: color, opacity: on ? 1 : 0.3 }} />
              {label}
            </button>
          );
        })}
      </div>
      <div className="stem-picker-foot">
        <div className="row" style={{ gap: 14 }}>
          <button
            type="button"
            className="stem-all"
            onClick={() => onChange([...STEM_NAMES])}
            disabled={disabled || allOn}
          >
            Select all
          </button>
          <button
            type="button"
            className="stem-all"
            onClick={() => onChange([])}
            disabled={disabled || noneOn}
          >
            Clear
          </button>
        </div>
        <span className="hint">
          {noneOn ? 'No separation — original track' : `${value.length} of ${STEM_NAMES.length} selected`}
        </span>
      </div>
    </div>
  );
}
