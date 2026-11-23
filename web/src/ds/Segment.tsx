// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** A segmented single choice with roving focus and the standard arrow-key radio behaviour. */
export function Segment<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <span className="seg" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          type="button"
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={event => {
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : step
                    ? (i + step + options.length) % options.length
                    : null;
            if (next !== null) {
              event.preventDefault();
              onChange(options[next]!.value);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }
          }}
        >
          {option.text}
        </button>
      ))}
    </span>
  );
}
