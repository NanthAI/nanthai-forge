// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Small pieces the getting-started screens share: the copy key whose label reads "Copied" for two seconds (DESIGN.md
// rule 22), a command block a person copies, the one-line first-run help that goes away once read (rule 29: no standing
// explainers), and the connection steps with the app choice in their last step.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConvexReactClient } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Key, Row, State, useFold } from '../../ds';
import { A } from '../frames';
import {
  agentAppLabels,
  agentApps,
  appStep,
  appStepDocs,
  appStepTitle,
  guidanceDocs,
  rememberApp,
  rememberedApp,
  sharedSteps,
  type AgentApp,
  type DocsLink,
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
  const announce = (word: 'Copied' | 'Select the text to copy') => {
    setSaid(word);
    clearTimeout(timer.current);
    // One timer, only after a press: the label returns; nothing runs while the page sits idle.
    timer.current = setTimeout(() => setSaid(''), 2000);
  };
  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return announce('Select the text to copy');
    void clipboard
      .writeText(text)
      .then(() => announce('Copied'))
      .catch(() => announce('Select the text to copy'));
  };
  return (
    <>
      <Key kind={kind} size={size} onClick={copy}>
        {said || label}
      </Key>
      <span className="sr" role="status" aria-live="polite">
        {said}
      </span>
    </>
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

/** The docs that explain a step: quiet links, so no explainer stands on the page (DESIGN.md rule 29). */
function DocsLinks({ docs }: { docs?: readonly DocsLink[] }) {
  if (!docs?.length) return null;
  return (
    <div className="meta gs-docs">
      <span className="t3">Docs:</span>
      {docs.map(doc => (
        <a key={doc.href} className="lk" href={doc.href}>
          {doc.label}
        </a>
      ))}
    </div>
  );
}

/** One connection flow for every agent app: the steps all apps share, then the one optional step that differs, where
 * the app is chosen. No app is pressed until this browser picks one; picking changes only that step. */
export function ConnectSteps({
  deployment,
  project,
  connectionClient,
}: {
  deployment: string;
  project?: string;
  connectionClient?: Pick<ConvexReactClient, 'query'> | undefined;
}) {
  const [app, setApp] = useState<AgentApp | null>(rememberedApp);
  const [connected, setConnected] = useState<readonly AgentApp[]>();
  useEffect(() => {
    if (!connectionClient) return;
    let open = true;
    void connectionClient
      .query(api.agentConnections.read, {})
      .then(apps => open && setConnected(apps))
      .catch(() => {});
    return () => {
      open = false;
    };
  }, [connectionClient]);
  const pick = (next: AgentApp) => {
    setApp(next);
    rememberApp(next);
  };
  const shared = sharedSteps(deployment, project);
  const last = app ? appStep(app) : null;
  return (
    <>
      <ol className="gs-steps" aria-label={`Steps for ${app ? agentAppLabels[app] : 'any agent app'}`}>
        {shared.map((step, index) => (
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
                {step.detail ? (
                  <div className="meta">
                    {step.detail}
                    {step.link ? (
                      <>
                        {' '}
                        <A className="lk" href={step.link.href}>
                          {step.link.label}
                        </A>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <CommandBlock label={step.title} text={step.commands.join('\n')} />
                <DocsLinks docs={step.docs} />
              </div>
            </Row>
          </li>
        ))}
        <li>
          <Row cols="28px minmax(0, 1fr)" className="gs-step">
            <span className="num t3" aria-hidden="true">
              {shared.length + 1}
            </span>
            <div className="gs-stack">
              <div className="ttl">
                {appStepTitle}
                <span className="t3"> · optional</span>
              </div>
              <div className="gs-apps">
                <div className="seg" role="group" aria-label="Your agent app">
                  {agentApps.map(name => (
                    <button type="button" key={name} aria-pressed={app === name} onClick={() => pick(name)}>
                      {agentAppLabels[name]}
                    </button>
                  ))}
                </div>
              </div>
              {last ? (
                <>
                  <CommandBlock label={last.title} text={last.commands.join('\n')} />
                  {app === 'other' ? (
                    <div className="meta">{last.detail}</div>
                  ) : (
                    <>
                      <div className="meta">
                        {app && connected?.includes(app) ? (
                          <State word="Done">Connected</State>
                        ) : (
                          'Run from the project folder. Open a new agent session, then refresh this page.'
                        )}
                      </div>
                      <details>
                        <summary className="meta">Manual setup</summary>
                        <p className="meta">{last.detail} Remove the entry to undo.</p>
                        <CommandBlock
                          label="Print the Forge MCP entry"
                          text={`nforge mcp-config . --agent --client ${app}`}
                        />
                      </details>
                    </>
                  )}
                </>
              ) : null}
              <DocsLinks docs={appStepDocs} />
            </div>
          </Row>
        </li>
      </ol>
      <p className="pf">
        <a className="lk" href={guidanceDocs.href}>
          {guidanceDocs.label}
        </a>
      </p>
    </>
  );
}
