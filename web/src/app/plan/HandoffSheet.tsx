// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Hand an Item to an agent (Flow Spec 02): copies the short prompt and shows how to connect an unconnected agent app
// using the shared getting-started helpers (agent-apps.ts). Reads connected apps only when opened; never starts an
// agent itself.
import { useEffect, useState } from 'react';
import { Key, Sheet, State } from '../../ds';
import {
  agentAppLabels,
  agentApps,
  appStep,
  appStepDocs,
  rememberApp,
  rememberedApp,
  sharedSteps,
  type AgentApp,
} from '../start/agent-apps';
import { CommandBlock, CopyKey } from '../start/parts';
import '../start/start.css';

export function HandoffSheet({
  open,
  onOpenChange,
  prompt,
  projectUrl,
  readConnectedApps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: string;
  projectUrl: string;
  readConnectedApps?: (() => Promise<readonly AgentApp[]>) | undefined;
}) {
  const [app, setApp] = useState<AgentApp | null>(rememberedApp);
  const [connected, setConnected] = useState<readonly AgentApp[]>();
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    if (!open || !readConnectedApps) return;
    let live = true;
    void readConnectedApps()
      .then(apps => {
        if (live) setConnected(apps);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, readConnectedApps]);

  const pick = (next: AgentApp) => {
    setApp(next);
    rememberApp(next);
  };
  const step = app ? appStep(app) : null;
  const isConnected = Boolean(app && connected?.includes(app));
  const shared = setupOpen ? sharedSteps(location.origin, projectUrl) : null;

  return (
    <Sheet
      title="Hand to an agent"
      open={open}
      onOpenChange={next => {
        if (!next) setSetupOpen(false);
        onOpenChange(next);
      }}
      footer={<CopyKey text={prompt} label="Copy prompt" kind="primary" />}
    >
      <div className="ip-handoff">
        <p>Paste the prompt into your agent to start work on this Item.</p>
        <details>
          <summary className="btn ghost">
            Show prompt <span className="tw" aria-hidden="true" />
          </summary>
          <pre className="cmd mono" translate="no">
            {prompt}
          </pre>
        </details>
        <div className="ip-connect">
          <div className="meta">
            {connected?.length === 0
              ? 'No agent app connected yet. Pick your app for its connect command, or copy the prompt if you run nforge in a terminal.'
              : connected?.length
                ? `Connected: ${connected.map(name => agentAppLabels[name]).join(', ')}. Pick another app to connect it.`
                : 'Need to connect an agent app? Pick your app for its connect command.'}
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
          {step && app ? (
            isConnected ? (
              <div className="meta">
                <State word="Done">Connected</State> — paste the prompt in a new {agentAppLabels[app]}{' '}
                session.
              </div>
            ) : (
              <>
                <CommandBlock label={step.title} text={step.commands.join('\n')} />
                {app === 'other' ? (
                  <div className="meta">{step.detail}</div>
                ) : (
                  <>
                    <div className="meta">Run from the project folder, then open a new agent session.</div>
                    <details>
                      <summary className="meta">Manual setup</summary>
                      <p className="meta">{step.detail} Remove the entry to undo.</p>
                      <CommandBlock
                        label="Print the Forge MCP entry"
                        text={`nforge mcp-config . --agent --client ${app}`}
                      />
                    </details>
                  </>
                )}
              </>
            )
          ) : null}
          <div>
            <Key
              size="sm"
              kind="ghost"
              aria-expanded={setupOpen}
              onClick={() => setSetupOpen(current => !current)}
            >
              {setupOpen
                ? 'Hide machine setup steps'
                : 'First time on this machine? Install, sign in and clone'}
            </Key>
          </div>
          {shared ? (
            <ol className="ip-setup-steps" aria-label="First-time machine setup">
              {shared.map(item => (
                <li key={item.title} className="gs-stack">
                  <div className="ttl">{item.title}</div>
                  <CommandBlock label={item.title} text={item.commands.join('\n')} />
                </li>
              ))}
            </ol>
          ) : null}
          <div className="meta gs-docs">
            <span className="t3">Docs:</span>
            {appStepDocs.map(doc => (
              <a key={doc.href} className="lk" href={doc.href}>
                {doc.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
