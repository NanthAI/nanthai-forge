import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Button } from '../ui/primitives';

const LIMIT = 4000;
export type Guidance = { project: string; personal: string };

/** One guidance text (project or personal), at most 4,000 characters, saved explicitly. */
export function GuidanceField({
  label,
  hint,
  value,
  save,
  disabled,
}: {
  disabled?: string;
  label: string;
  hint: string;
  value: string;
  save: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(value),
    [state, setState] = useState<'' | 'saving' | 'saved' | string>('');
  useEffect(() => setText(value), [value]);
  const dirty = text !== value;
  return (
    <form className="fx-guidance" onSubmit={event => event.preventDefault()}>
      <label>
        <span className="fx-guidance-label">{label}</span>
        <span className="fx-faint">{hint}</span>
        <textarea
          disabled={Boolean(disabled)}
          className="fx-input"
          rows={5}
          maxLength={LIMIT}
          value={text}
          onChange={event => {
            setText(event.target.value);
            setState('');
          }}
          placeholder="For example: keep changes small, run npm run verify before finishing, never touch generated files."
        />
      </label>
      <div className="fx-guidance-foot">
        <span className="fx-faint">
          {text.length.toLocaleString()} / {LIMIT.toLocaleString()}
        </span>
        {disabled && <span className="fx-faint">{disabled}</span>}
        {state &&
          state !== 'saving' &&
          (state === 'saved' ? (
            <span className="fx-c-passed" role="status">
              Saved
            </span>
          ) : (
            <ErrorToast error={state} />
          ))}
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'secondary'}
          disabled={Boolean(disabled) || !dirty || state === 'saving'}
          onClick={() => {
            setState('saving');
            save(text).then(
              () => setState('saved'),
              e => setState((e as Error).message),
            );
          }}
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
