// SPDX-License-Identifier: Apache-2.0
// Small pieces the getting-started screens share: the copy key whose label reads "Copied" for two seconds (DESIGN.md
// rule 22), a command block a person copies, the one-line first-run help that goes away once read (rule 29: no standing
// explainers), and the app picker with each app's connection steps.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Band, Key, Row, useFold } from '../../ds';
import { A } from '../frames';
import {
  agentAppLabels,
  agentApps,
  rememberApp,
  rememberedApp,
  setupSteps,
  type AgentApp,
} from './agent-apps';

/** Copies `text`; the label says "Copied" for two seconds, or says plainly that copying did not work. */
export function CopyKey({
  text,
  label,
  kind,
  size,
}: {
  text: string;
  label: string;
  kind?: 'primary' | 'rec' | 'ghost';
  size?: 'sm' | 'lg';
}) {
  const [said, setSaid] = useState<'' | 'Copied' | 'Select the text to copy'>('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => 'Copied' as const)
      .catch(() => 'Select the text to copy' as const)
      .then(word => {
        setSaid(word);
        clearTimeout(timer.current);
        // One timer, only after a press: the label returns; nothing runs while the page sits idle.
        timer.current = setTimeout(() => setSaid(''), 2000);
      });
  };
  return (
    <Key kind={kind} size={size} onClick={copy} aria-live="polite">
      {said || label}
    </Key>
  );
}

/** A command or prompt a person copies, with its own small copy key. */
export function CommandBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="gs-cmd">
      <pre className="cmd mono" aria-label={label} translate="no">
        {text}
      </pre>
      <CopyKey text={text} label="Copy" size="sm" kind="ghost" />
    </div>
  );
}

/** One line of help shown until the reader closes it; remembered per browser with the fold store. */
export function FirstRunLine({ id, children }: { id: string; children: ReactNode }) {
  const [open, close] = useFold(`first-run.${id}`, true);
  if (!open) return null;
  return (
    <p className="gs-first" role="note">
      <span>{children}</span>
      <Key kind="ghost" size="sm" onClick={close}>
        Got it
      </Key>
    </p>
  );
}

/** The app picker and that app's steps. Picking an app changes only what is shown (and is remembered). */
export function ConnectSteps({ deployment, project }: { deployment: string; project?: string }) {
  const [app, setApp] = useState<AgentApp>(rememberedApp);
  const pick = (next: AgentApp) => {
    setApp(next);
    rememberApp(next);
  };
  return (
    <>
      <div className="pad gs-apps">
        <div className="seg" role="group" aria-label="Your agent app">
          {agentApps.map(name => (
            <button type="button" key={name} aria-pressed={app === name} onClick={() => pick(name)}>
              {agentAppLabels[name]}
            </button>
          ))}
        </div>
      </div>
      <Band title={`With ${agentAppLabels[app]}`} hint="in a terminal, inside the repository folder" />
      <ol className="gs-steps" aria-label={`Steps for ${agentAppLabels[app]}`}>
        {setupSteps(app, deployment, project).map((step, index) => (
          <li key={step.title}>
            <Row cols="28px minmax(0, 1fr)" className="gs-step">
              <span className="num t3" aria-hidden="true">
                {index + 1}
              </span>
              <div className="gs-stack">
                <div className="ttl">
                  {step.title}
                  {step.needsPerson ? <span className="t3"> · needs you once</span> : null}
                </div>
                <div className="meta">
                  {step.detail}
                  {step.link ? (
                    <>
                      {' '}
                      <A href={step.link.href}>{step.link.label}</A>
                    </>
                  ) : null}
                </div>
                <CommandBlock label={step.title} text={step.commands.join('\n')} />
              </div>
            </Row>
          </li>
        ))}
      </ol>
    </>
  );
}
