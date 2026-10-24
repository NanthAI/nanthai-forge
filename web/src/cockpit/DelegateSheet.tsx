import { useReadRetry } from '../ui/read-retry';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { Avatar, Button, StatusPill } from '../ui/primitives';
import type { Tone } from '../ui/status';
import { Sheet } from '../ui/Sheet';
import { InfoTip } from '../ui/signals';
import {
  agentNames,
  rememberAgent,
  rememberedAgent,
  useBriefSource,
  type Brief,
  type BriefAgent,
  type BriefRequest,
} from './brief';
import { agentOf, goalNote, knowRows } from './delegate-model';

/** Sends the prompt to a running session's inbox. Provided where live coordination exists (hosted). */
export type InboxSend = (recipient: string, text: string, laneId?: string) => Promise<void>;
export const InboxContext = createContext<InboxSend | null>(null);

/** The sheet's context line: status, Lane and Intent. */
export function DelegateSubject({
  subject,
}: {
  subject: { tone: Tone; label: string; lane: string; intent: string };
}) {
  return (
    <>
      <StatusPill tone={subject.tone}>{subject.label}</StatusPill>
      <span>{subject.lane}</span>
      {subject.intent !== subject.lane && (
        <>
          <span aria-hidden="true">·</span>
          <Glyph name="intent" size={11} />
          <span>{subject.intent}</span>
        </>
      )}
    </>
  );
}

/** The session already on this work, which can simply continue it. */
export type Continues = { name: string; environment?: string; harness?: string; recipient?: string };

/**
 * "Hand this to an agent": the goal, who will do it, what the agent will know (sources on hover),
 * the collapsed prompt and one Copy. The prompt tells the agent to fetch the full briefing itself.
 */
export function DelegateSheet({
  request,
  continues,
  context,
  onClose,
}: {
  request: Omit<BriefRequest, 'agent'>;
  continues?: Continues;
  context?: ReactNode;
  onClose: () => void;
}) {
  const readAttempt = useReadRetry();
  const source = useBriefSource();
  const inbox = useContext(InboxContext);
  const [choice, setChoice] = useState<'continue' | BriefAgent>(continues ? 'continue' : rememberedAgent);
  const agent: BriefAgent =
    choice === 'continue' ? agentOf(continues?.environment, continues?.harness) : choice;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [notify, setNotify] = useState(true);
  const sent = useRef(new Set<string>());
  const key = JSON.stringify(request);
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    setBrief(null);
    setError('');
    source({ ...(JSON.parse(key) as Omit<BriefRequest, 'agent'>), agent }, controller.signal)
      .then(value => !controller.signal.aborted && setBrief(value))
      .catch(e => !controller.signal.aborted && setError((e as Error).message));
    return () => controller.abort();
  }, [agent, key, source, readAttempt]);
  const canNotify = Boolean(inbox && choice === 'continue' && continues?.recipient);
  const copy = async () => {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief.copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy was blocked by the browser. Open the prompt below and copy it by hand.');
      return;
    }
    // One inbox message per prompt text, however often Copy is pressed.
    if (canNotify && notify && !sent.current.has(brief.copyText)) {
      try {
        await inbox!(continues!.recipient!, brief.copyText, request.laneId);
        sent.current.add(brief.copyText);
      } catch (e) {
        setError(`Copied, but the inbox message failed: ${(e as Error).message}`);
      }
    }
  };
  const rows = brief ? knowRows(brief) : [];
  const note = brief ? goalNote(brief) : '';
  const options: { id: 'continue' | BriefAgent; label: ReactNode }[] = [
    ...(continues
      ? [
          {
            id: 'continue' as const,
            label: (
              <>
                <Avatar name={continues.name} kind="agent" size="sm" /> {continues.name}
                <span className="fx-faint"> · continues</span>
              </>
            ),
          },
        ]
      : []),
    ...(['claude-code', 'codex', 'generic'] as const).map(id => ({
      id,
      label: id === 'generic' ? 'Other' : agentNames[id],
    })),
  ];
  return (
    <Sheet title="Hand this to an agent" glyph="handoff" context={context} onClose={onClose}>
      {!source ? (
        <p className="fx-muted">Prompts are not available here.</p>
      ) : (
        <>
          <div className="fx-dg-goal">
            {brief ? brief.title : 'Preparing…'}
            {note && <small>{note}</small>}
          </div>
          <div className="fx-seg fx-dg-agents" role="group" aria-label="Agent">
            {options.map(option => (
              <button
                key={option.id}
                type="button"
                aria-pressed={choice === option.id}
                onClick={() => {
                  setChoice(option.id);
                  if (option.id !== 'continue') rememberAgent(option.id);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {error && <ErrorToast>{error}</ErrorToast>}
          {brief && (
            <>
              <section aria-labelledby="fx-dg-knows">
                <div className="fx-dg-eyebrow">
                  <span id="fx-dg-knows" className="fx-eyebrow">
                    What the agent will know
                  </span>
                  <InfoTip label="How the briefing is built" inline>
                    Built from Forge&apos;s own records: the Lane, main, overlaps, the repo&apos;s instruction
                    files and your Settings. The agent reads only what you can read; the prompt tells it to
                    fetch the full briefing itself.
                  </InfoTip>
                </div>
                <ul className="fx-dg-knows">
                  {rows.map(row => (
                    <li
                      key={row.key}
                      tabIndex={0}
                      className={row.off ? 'fx-dg-off' : undefined}
                      title={`From ${row.source}`}
                    >
                      <Glyph name={row.off ? 'close' : 'passed'} size={12} />
                      <span>
                        {row.off ? row.label : <b>{row.label}</b>}
                        {row.detail && <>: {row.detail}</>}
                      </span>
                      <span className="fx-dg-src">{row.source}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <details className="fx-dg-prompt">
                <summary>
                  <Glyph name="terminal" size={12} />
                  The prompt
                  <span className="fx-dg-len">{brief.copyText.length} chars</span>
                </summary>
                <pre>{brief.copyText}</pre>
              </details>
              <div className="fx-dg-cta">
                <Button
                  variant="primary"
                  size="lg"
                  icon={copied ? 'passed' : 'copy'}
                  className={copied ? 'fx-btn-copied' : undefined}
                  onClick={() => void copy()}
                >
                  {copied ? 'Copied' : 'Copy prompt'}
                </Button>
                {canNotify && (
                  <label className="fx-dg-opt">
                    <input
                      type="checkbox"
                      checked={notify}
                      onChange={event => setNotify(event.target.checked)}
                    />{' '}
                    Also send to {continues!.name}&apos;s inbox
                  </label>
                )}
              </div>
              {copied && (
                <p className="fx-dg-copied" role="status">
                  <Glyph name="passed" size={13} />
                  <span>
                    <b>Copied.</b> Paste into {choice === 'continue' ? continues!.name : agentNames[agent]} on{' '}
                    {brief.setup.machine ?? 'your machine'}.
                  </span>
                </p>
              )}
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
