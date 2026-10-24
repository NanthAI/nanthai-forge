import { countLabel } from '../ui/count';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type ReactNode } from 'react';
import { AliveHero } from './AliveHero';
import { GitHubGlyph } from './GitHubGlyph';
import { Glyph, type GlyphName } from '../ui/Glyph';
import { Button } from '../ui/primitives';

/** The signed-out front door: what Forge is in one line, and a way to see it on a real repository. */
export function Landing({
  open,
  busy,
  error,
  signIn,
  more,
}: {
  open: (url: string) => void;
  busy: boolean;
  error: string;
  demo?: string;
  signIn?: ReactNode;
  more?: ReactNode;
}) {
  const [url, setUrl] = useState('');
  const id = useId();
  return (
    <div className="fx-landing">
      <section className="fx-hero" aria-labelledby={`${id}-title`}>
        <div className="fx-hero-field" aria-hidden="true">
          <AliveHero />
        </div>
        <div className="fx-hero-content">
          <h1 id={`${id}-title`}>
            Hand it off.
            <br />
            Watch it <span>land.</span>
          </h1>
          <p className="fx-hero-lead">
            People and AI coding agents change the same code at once, each in its own Lane, with every change
            checked before it lands and one screen showing who is doing what.
          </p>
          <form
            className="fx-hero-form"
            onSubmit={event => {
              event.preventDefault();
              if (url.trim() && !busy) open(url.trim());
            }}
          >
            <label htmlFor={`${id}-url`} className="fx-sr">
              Public GitHub repository
            </label>
            <span className="fx-hero-input">
              <GitHubGlyph />
              <input
                id={`${id}-url`}
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="github.com/nanthai/forge"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </span>
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? 'Importing…' : 'Preview with Forge'}
              <Glyph name="arrow" size={15} />
            </Button>
          </form>
          {error && <ErrorToast>{error}</ErrorToast>}
          <p className="fx-hero-note">Public repositories · no account needed</p>
          {signIn && <div className="fx-hero-signin">{signIn}</div>}
        </div>
      </section>
      <section className="fx-steps" aria-label="What Forge shows you">
        <Step
          glyph="lane"
          title="A Lane for everyone"
          text="Each person and each agent works in an isolated copy. Overlaps are shown early, as advice, never as locks."
        />
        <Step
          glyph="check"
          title="A check before main"
          text="Every acceptance records the exact code it ran on. If the check fails, the Lane comes back to you with the failing test, not a red wall."
        />
        <Step
          glyph="now"
          title="One screen that needs you"
          text="Now shows who's working, what's changing, what overlaps and what needs a decision. Everything else is a click deeper."
        />
      </section>
      <section className="fx-landing-guard">
        <h2>Delegate as much as you like.</h2>
        <p>
          Autonomy is a per-project dial, from Supervised to Autonomous.{' '}
          <a href="https://github.com/nanthai/forge/blob/main/docs/concepts.md#autonomy">
            How the guardrails work →
          </a>
        </p>
      </section>
      {more}
      <footer className="fx-landing-footer">
        <span>© 2026 NanthAi</span>
        <span>Open development · Forge builds itself</span>
        <div className="fx-landing-footer-links">
          <a href="https://github.com/nanthai/forge#readme">Docs</a>
          <a href="https://github.com/nanthai/forge/blob/main/docs/security.md">Security</a>
          <a href="?surface=contact">Contact</a>
        </div>
      </footer>
    </div>
  );
}

function Step({ glyph, title, text }: { glyph: GlyphName; title: string; text: string }) {
  return (
    <div className="fx-step">
      <span className="fx-step-icon">
        <Glyph name={glyph} size={14} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

/** Import progress in the same visual language as the front door. */
export function Importing({
  repository,
  phase,
  processed,
  total,
  error,
  retry,
  back,
}: {
  repository?: string;
  phase?: string;
  processed?: number;
  total?: number;
  error?: string;
  retry?: () => void;
  back: () => void;
}) {
  const share = total ? Math.min(100, Math.round(((processed ?? 0) / total) * 100)) : 0;
  return (
    <div className="fx-landing">
      <section className="fx-hero fx-hero-compact">
        <div className="fx-hero-field" aria-hidden="true">
          <AliveHero />
        </div>
        <div className="fx-hero-content">
          <p className="fx-import-status">{error ? '' : 'Reading the repository'}</p>
          <h1 className="fx-hero-repo">{repository ?? 'Connecting…'}</h1>
          <div
            className="fx-progress"
            role="progressbar"
            aria-valuenow={share}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              style={{ width: `${error ? 100 : total ? share : 8}%` }}
              className={error ? 'fx-progress-bad' : undefined}
            />
          </div>
          {error ? (
            <ErrorToast error={error} {...(retry ? { retry } : {})} />
          ) : (
            <p className="fx-hero-note" role="status">
              {total
                ? `${phase ?? 'indexing'} · ${processed ?? 0} of ${countLabel(total, 'file')}`
                : `${phase ?? 'starting'}…`}
            </p>
          )}
          <div className="fx-hero-try">
            <button type="button" onClick={back}>
              Choose another repository
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
