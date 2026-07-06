'use client';

import {
  isStemName,
  orderSelection,
  REMAINING_STEM,
  STEM_META,
  STEM_NAMES,
  type SelectableStem,
  type StemName,
} from '@prismaxim/shared';

export interface StemPickerProps {
  value: SelectableStem[];
  onChange: (stems: SelectableStem[]) => void;
  /** disable interaction (e.g. while a job is running) */
  disabled?: boolean;
}

/**
 * Toggle grid for choosing which stems to separate: the 6 individual sources
 * plus an optional "Remaining instruments" bucket that sums every source you
 * didn't pick individually into one extra track (e.g. Vocals + Remaining →
 * a vocals track and one accompaniment track). Zero selected is a valid state —
 * it means "no separation, keep the original track" (handled by the caller). The
 * emitted list is always canonicalised (STEM_NAMES order, remaining last).
 */
export default function StemPicker({ value, onChange, disabled }: StemPickerProps) {
  const selectedReal = STEM_NAMES.filter((n) => value.includes(n));
  const selected = new Set<StemName>(selectedReal);
  const remainingOn = value.includes(REMAINING_STEM);
  // Sources that would flow into the remaining track (the ones not picked individually).
  const leftover = STEM_NAMES.filter((n) => !selected.has(n));

  const allOn = selectedReal.length === STEM_NAMES.length;
  const noneOn = value.length === 0;

  const emit = (reals: Set<StemName>, remaining: boolean) => {
    const next: string[] = [...reals];
    if (remaining) next.push(REMAINING_STEM);
    onChange(orderSelection(next));
  };

  const toggle = (name: StemName) => {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    // Picking all 6 individually leaves nothing for the remaining bucket — drop it.
    const remaining = next.size === STEM_NAMES.length ? false : remainingOn;
    emit(next, remaining);
  };

  const toggleRemaining = () => {
    if (disabled || allOn) return;
    emit(selected, !remainingOn);
  };

  const remainingHint = remainingOn
    ? leftover.length
      ? leftover.map((n) => STEM_META[n].label).join(', ')
      : 'nothing left'
    : leftover.length === STEM_NAMES.length
      ? 'Everything as one instrumental track'
      : `Adds one track: ${leftover.map((n) => STEM_META[n].label).join(', ')}`;

  const trackCount = selectedReal.length + (remainingOn && leftover.length ? 1 : 0);

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

      {/* Remaining instruments: one summed track of everything not picked above. */}
      <button
        type="button"
        className={`stem-chip stem-remaining${remainingOn ? ' active' : ''}`}
        onClick={toggleRemaining}
        disabled={disabled || allOn}
        aria-pressed={remainingOn}
        style={remainingOn ? { borderColor: STEM_META[REMAINING_STEM].color } : undefined}
        title={allOn ? 'Pick fewer instruments above to enable a remaining track' : undefined}
      >
        <span
          className="stem-dot"
          style={{ background: STEM_META[REMAINING_STEM].color, opacity: remainingOn ? 1 : 0.3 }}
        />
        <span className="stem-remaining-text">
          <span>Remaining instruments</span>
          <span className="hint">
            {allOn ? 'All 6 stems picked — nothing remaining' : remainingHint}
          </span>
        </span>
      </button>

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
          {noneOn
            ? 'No separation — original track'
            : `${trackCount} track${trackCount === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  );
}
