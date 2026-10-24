// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { Button } from '../ui/primitives';
import { Rail } from '../ui/Rail';

/** Now before anything exists: three steps, and one setup line when it matters. */
export function FirstRun({
  newIntent,
  setup,
  docsHref,
}: {
  newIntent: () => void;
  /** One line about agent tools on this machine, only when something needs doing. */
  setup?: ReactNode;
  docsHref?: string;
}) {
  return (
    <div className="fx-first">
      <div className="fx-run-steps" role="list">
        <div className="fx-run-step fx-run-step-now" role="listitem">
          <h3>
            <span className="fx-run-step-n">1</span> Create an Intent
          </h3>
          <p>The outcome, in a sentence: “Fix tax rounding on gift cards.” It gets its own Lane.</p>
          <div className="fx-run-step-foot">
            <Button variant="rec" size="sm" icon="plus" onClick={newIntent}>
              New Intent
            </Button>
          </div>
        </div>
        <div className="fx-run-step" role="listitem">
          <h3>
            <span className="fx-run-step-n">2</span> Hand it to an agent
          </h3>
          <p>Copy the prompt into Claude Code, Codex or any agent. It works in the Lane.</p>
          <div className="fx-run-step-foot">
            <span className="fx-chip">
              <Glyph name="copy" size={12} /> Copy prompt
            </span>
          </div>
        </div>
        <div className="fx-run-step" role="listitem">
          <h3>
            <span className="fx-run-step-n">3</span> Accept when it’s green
          </h3>
          <p>When the check passes, Needs you asks for one decision.</p>
          <div className="fx-run-step-foot">
            <Rail lane={{ tone: 'plain', checkpoints: 1, accepted: true }} />
            <span className="fx-faint">edited · saved · checked · accepted</span>
          </div>
        </div>
      </div>
      {docsHref && (
        <a className="fx-first-docs" href={docsHref} target="_blank" rel="noreferrer">
          How Forge works ↗
        </a>
      )}
      {setup}
    </div>
  );
}
