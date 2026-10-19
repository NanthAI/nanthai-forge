// SPDX-License-Identifier: Apache-2.0
import './source-picker.css';
import { useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { Menu } from '../ui/Menu';
import { resolveHead, type SourceOption, type sourceOptions } from './source-options';

/** The only "which source" control in Code: main · Open Lanes · Recent Candidates · Exact head. */
export function SourcePicker({
  current,
  options,
  choose,
  className,
}: {
  current: SourceOption;
  options: ReturnType<typeof sourceOptions>;
  choose: (head: string | null, laneId?: string) => void;
  className?: string;
}) {
  const [hash, setHash] = useState('');
  const [invalid, setInvalid] = useState(false);
  const all = [options.main, ...options.lanes, ...options.candidates];
  const known = all.map(option => option.head);
  const item = (option: SourceOption) => (
    <button
      type="button"
      key={option.key}
      aria-current={option.key === current.key || undefined}
      onClick={() => choose(option.key === 'main' ? null : option.head, option.laneId)}
    >
      <Glyph name={option.glyph} size={14} />
      <span className="fx-source-name" title={option.name}>
        {option.name}
      </span>
      <span className="fx-source-meta">{option.meta}</span>
    </button>
  );
  return (
    <Menu
      className={['fx-source', className].filter(Boolean).join(' ')}
      ariaLabel={`Source: ${current.name}`}
      label={
        <>
          <span className="fx-source-label">Source</span>
          <b title={current.name}>
            <Glyph name={current.glyph} size={13} />
            <span>{current.name}</span>
          </b>
          <span className="fx-source-meta">{current.meta}</span>
          <Glyph name="down" size={13} />
        </>
      }
    >
      <div className="fx-source-menu">
        {item(options.main)}
        {options.lanes.length > 0 && <div className="fx-source-group">Open Lanes</div>}
        {options.lanes.map(item)}
        {options.candidates.length > 0 && <div className="fx-source-group">Recent Views</div>}
        {options.candidates.map(item)}
        <form
          className="fx-source-exact"
          onSubmit={event => {
            event.preventDefault();
            const head = resolveHead(hash, known);
            setInvalid(!head);
            if (!head) return;
            setHash('');
            // A pasted hash that names a listed source reads as that source.
            const match = all.find(option => option.head === head);
            choose(match?.key === 'main' ? null : head, match?.laneId);
          }}
        >
          <label>
            <span className="fx-source-group">Exact head…</span>
            <input
              value={hash}
              onChange={event => {
                setHash(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={event => {
                if (['Home', 'End'].includes(event.key)) event.stopPropagation();
              }}
              placeholder="Paste a hash"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? 'fx-source-exact-error' : undefined}
            />
            {invalid && (
              <span id="fx-source-exact-error" className="fx-source-error" role="alert">
                No save matches that hash.
              </span>
            )}
          </label>
        </form>
      </div>
    </Menu>
  );
}
