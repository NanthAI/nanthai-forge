import { useGenerationFreshness } from './generation-freshness';
import { ErrorToast } from './Toast';
// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import { concepts, type Concept } from './concepts';
import { hue, initials, toneLabel, type Tone } from './status';

/** `rec` is the recommended answer in a decision: outlined, never orange. */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'rec';
/** `xl` is for the public landing only; `lg` is the single primary on app screens. */
type Size = 'sm' | 'md' | 'lg' | 'xl';
const buttonClass = (variant: Variant, size: Size, className?: string) =>
  ['fx-btn', `fx-btn-${variant}`, size !== 'md' && `fx-btn-${size}`, className].filter(Boolean).join(' ');

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: GlyphName }) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Glyph name={icon} size={size === 'lg' || size === 'xl' ? 15 : 14} />}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; icon?: GlyphName }) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Glyph name={icon} size={size === 'lg' || size === 'xl' ? 15 : 14} />}
      {children}
    </a>
  );
}

export function Panel({
  title,
  count,
  actions,
  footer,
  children,
  className,
  labelId,
  hot = false,
}: {
  title?: ReactNode;
  count?: ReactNode;
  /** Only the Needs-you panel: the count takes the brand fill while it is above zero. */
  hot?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  labelId?: string;
}) {
  return (
    <section className={className ? `fx-panel ${className}` : 'fx-panel'} aria-labelledby={labelId}>
      {title !== undefined && (
        <header className="fx-panel-h">
          <h2 id={labelId}>{title}</h2>
          {count !== undefined && (
            <span className={hot && count !== 0 ? 'fx-count fx-count-hot' : 'fx-count'}>{count}</span>
          )}
          {actions && <div className="fx-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
      {footer && <footer className="fx-panel-f">{footer}</footer>}
    </section>
  );
}

const toneGlyph: Record<Tone, GlyphName> = {
  active: 'active',
  waiting: 'waiting',
  stale: 'stale',
  conflict: 'conflict',
  passed: 'passed',
  failed: 'failed',
  running: 'running',
  plain: 'plain',
};
export function StatusPill({
  tone,
  children,
  glyph,
  title,
}: {
  title?: string;
  tone: Tone;
  children?: ReactNode;
  glyph?: GlyphName;
}) {
  const freshness = useGenerationFreshness();
  const tooltipId = useId();
  const muted = freshness.behind && ['active', 'running', 'waiting'].includes(tone);
  return (
    <span
      title={title}
      className={`fx-st fx-tone-${muted ? 'stale' : tone}`}
      aria-describedby={muted ? tooltipId : undefined}
      tabIndex={muted ? 0 : undefined}
    >
      <Glyph name={muted ? 'stale' : (glyph ?? toneGlyph[tone])} size={11} />
      {children ?? toneLabel[tone]}
      {muted && (
        <span role="tooltip" id={tooltipId} className="fx-info-tip">
          {freshness.asOf}
        </span>
      )}
    </span>
  );
}

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`fx-dot fx-dot-${tone}`} role={label ? 'img' : undefined} aria-label={label} />;
}

export function Avatar({
  name,
  identity,
  kind = 'human',
  size = 'md',
}: {
  name: string;
  identity?: string;
  kind?: 'human' | 'agent';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      className={`fx-av fx-av-${kind} fx-av-${size}`}
      style={{ ['--fx-av-h' as string]: hue(identity ?? name) }}
      title={kind === 'agent' ? `${name} (agent)` : name}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function PathChip({ path, variant = 'edit' }: { path: string; variant?: 'edit' | 'claim' | 'hot' }) {
  return (
    <code className={`fx-path fx-path-${variant}`} title={path}>
      {path}
    </code>
  );
}

export function DiffStat({ add, del, files }: { add: number; del: number; files?: number }) {
  return (
    <span className="fx-diffstat">
      <span className="fx-add">+{add.toLocaleString()}</span>{' '}
      <span className="fx-del">−{del.toLocaleString()}</span>
      {files !== undefined && (
        <span className="fx-diffstat-files">
          {files} {files === 1 ? 'file' : 'files'}
        </span>
      )}
    </span>
  );
}

export function Callout({
  tone,
  glyph,
  children,
  actions,
}: {
  tone: 'waiting' | 'conflict' | 'failed' | 'passed' | 'info';
  glyph?: GlyphName;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const fallback: GlyphName =
    tone === 'waiting' ? 'overlap' : tone === 'info' ? 'info' : (toneGlyph[tone] as GlyphName);
  if (tone === 'failed')
    return (
      <ErrorToast>
        {children}
        {actions}
      </ErrorToast>
    );
  return (
    <div className={`fx-callout fx-tone-${tone}`}>
      <Glyph name={glyph ?? fallback} size={15} />
      <div className="fx-callout-body">{children}</div>
      {actions && <div className="fx-callout-actions">{actions}</div>}
    </div>
  );
}

export function ConceptTerm({
  concept,
  explain,
  plural,
}: {
  concept: Concept;
  explain?: boolean;
  plural?: boolean;
}) {
  const term = concepts[concept];
  return (
    <span className="fx-concept" title={`${term.label}: ${term.explain}`}>
      <Glyph name={term.glyph} size={13} />
      <span>{plural ? term.plural : term.label}</span>
      {explain && <span className="fx-concept-explain">{term.explain}</span>}
    </span>
  );
}

export function ExactRecord({
  summary = 'Exact record',
  rows,
  open,
}: {
  summary?: ReactNode;
  open?: boolean;
  rows: readonly (readonly [label: string, value: string | undefined])[];
}) {
  const [copied, setCopied] = useState('');
  const present = rows.filter((row): row is readonly [string, string] => Boolean(row[1]));
  if (present.length === 0) return null;
  return (
    <details className="fx-record" open={open}>
      <summary>{summary}</summary>
      <dl>
        {present.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
              <button
                type="button"
                className="fx-icon-btn"
                aria-label={`Copy ${label}`}
                onClick={() =>
                  void navigator.clipboard?.writeText(value).then(
                    () => setCopied(label),
                    () => setCopied(''),
                  )
                }
              >
                <Glyph name={copied === label ? 'passed' : 'copy'} size={12} />
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Empty({
  glyph = 'info',
  title,
  children,
}: {
  glyph?: GlyphName;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="fx-empty">
      <span className="fx-empty-icon">
        <Glyph name={glyph} size={18} />
      </span>
      <h3>{title}</h3>
      {children && <div className="fx-empty-body">{children}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { id: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="fx-seg" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="fx-setting fx-switch-row">
      <b>{label}</b>
      <input
        className="fx-switch-input"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="fx-switch-track" aria-hidden="true" />
    </label>
  );
}
