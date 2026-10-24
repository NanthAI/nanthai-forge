import { countLabel } from '../ui/count';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { renderBriefing } from '../../../src/agent-brief-render';
import type { SourceRequest, Status } from '../api';
import { BriefSourceContext, agentNames, type BriefAgent, type BriefSource } from '../cockpit/brief';
import { HostedNowView } from '../cockpit/HostedNow';
import { PointField } from '../PointField';
import { useRepositoryGraph } from '../useRepositoryGraph';
import { Glyph } from '../ui/Glyph';
import { Button, Callout, Panel, Segmented } from '../ui/primitives';
import { exampleBriefContext, exampleIds, exampleWork, hubs } from './example';

const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'GEMINI.md'];
const noop = async () => true;

/** After a public import: the real graph, an example Now for this repository, and what an agent would see. */
export function DryRun({
  request,
  repository,
  openCode,
  back,
  signIn,
}: {
  request: SourceRequest;
  repository: string;
  openCode: () => void;
  back: () => void;
  signIn?: ReactNode;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [instructions, setInstructions] = useState<string[] | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    void request<Status>('status').then(setStatus, () => setStatus(null));
    void Promise.all(
      INSTRUCTION_CANDIDATES.map(file =>
        request<{ file: string }>(`readme?file=${encodeURIComponent(file)}`).then(
          () => file,
          () => null,
        ),
      ),
    ).then(found => setInstructions(found.filter((file): file is string => Boolean(file))));
  }, [request]);
  return (
    <div className="fx-page fx-tour">
      <div className="fx-tour-head">
        <div>
          <h1>
            Now, for <span className="fx-mono">{repository}</span>
          </h1>
          <p className="fx-page-summary">
            {status
              ? `${countLabel(status.files, 'source file')} · ${status.imports} imports`
              : 'Reading the index…'}
          </p>
        </div>
        <div className="fx-page-actions">
          <Button variant="ghost" onClick={back}>
            Try another repository
          </Button>
          <Button icon="code" onClick={openCode}>
            Open full Code view
          </Button>
          {signIn}
        </div>
      </div>

      {status && instructions ? (
        <Tour
          request={request}
          status={status}
          repository={repository}
          instructions={instructions}
          now={now}
        />
      ) : (
        <p className="fx-loading">Reading the repository…</p>
      )}
    </div>
  );
}

function Tour({
  request,
  status,
  repository,
  instructions,
  now,
}: {
  request: SourceRequest;
  status: Status;
  repository: string;
  instructions: string[];
  now: number;
}) {
  const graph = useRepositoryGraph({
    request,
    sourceId: status.sourceId,
    analysisId: status.analysisId,
    file: '',
    initial: null,
  });
  const files = useMemo(() => graph.nodes.map(node => node.id), [graph.nodes]);
  const name = repository.split('/').at(-1) ?? repository;
  const input = useMemo(
    () => ({ repository, files, edges: graph.edges, instructionFiles: instructions, now }),
    [repository, files, graph.edges, instructions, now],
  );
  const example = useMemo(() => exampleWork(input), [input]);
  const top = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    return hubs(files, graph.edges)
      .slice(0, 5)
      .map(file => ({ file, count: counts.get(file) ?? 0 }));
  }, [files, graph.edges]);
  const briefs: BriefSource = async request =>
    renderBriefing(
      { ...request, agent: request.agent },
      exampleBriefContext(input, example),
      `./${name}`,
      new Date(now).toISOString(),
    );
  const [agent, setAgent] = useState<BriefAgent>('claude-code');
  const prompt = useMemo(
    () =>
      renderBriefing(
        { situation: 'fix-failed-check', laneId: exampleIds.lanes[1], runId: exampleIds.runs[0], agent },
        exampleBriefContext(input, example),
        `./${name}`,
        new Date(now).toISOString(),
      ),
    [agent, input, example, name, now],
  );
  const [copied, setCopied] = useState(false);
  return (
    <>
      <section className="fx-tour-step" aria-labelledby="tour-1">
        <div className="fx-tour-label">
          <span>1</span>
          <h2 id="tour-1">Your code, as a map</h2>
          <p>Every point is a file; lines are imports.</p>
        </div>
        <div className="fx-tour-graph">
          <div className="fx-tour-canvas">
            {graph.nodes.length ? (
              <PointField nodes={graph.nodes} edges={graph.edges} />
            ) : (
              <p className="fx-loading">Drawing the graph…</p>
            )}
          </div>
          <Panel title="Most depended-on files">
            <ol className="fx-hubs">
              {top.map(item => (
                <li key={item.file}>
                  <code title={item.file}>{item.file}</code>
                  <span className="fx-faint">
                    {item.count} {item.count === 1 ? 'importer' : 'importers'}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </section>

      <section className="fx-tour-step" aria-labelledby="tour-2">
        <div className="fx-tour-label">
          <span>2</span>
          <h2 id="tour-2">Who is doing what, now</h2>
          <p>Example work on {name}, built from its real files.</p>
        </div>
        <div className="fx-example">
          <div className="fx-example-ribbon">
            <Glyph name="info" size={12} /> Example
          </div>
          <BriefSourceContext.Provider value={briefs}>
            <HostedNowView
              example={name}
              now={now}
              records={example.records}
              live={{ ...example, unackedComplete: true, sessionsLoading: false }}
              loading={false}
              ack={{ acknowledge: noop, reply: noop, busy: '', error: '', retrying: () => false }}
              newIntent={() => undefined}
              laneHref={() => '#tour-3'}
            />
          </BriefSourceContext.Provider>
        </div>
      </section>

      <section className="fx-tour-step" aria-labelledby="tour-3" id="tour-3">
        <div className="fx-tour-label">
          <span>3</span>
          <h2>What your agent would get</h2>
          <p>
            The prompt you would copy for the failing check above. Your agent then fetches the full, current
            context from Forge itself.
          </p>
        </div>
        <div className="fx-tour-prompt">
          {
            <Callout
              tone={instructions.length ? 'passed' : 'info'}
              glyph={instructions.length ? 'passed' : 'info'}
            >
              {instructions.length ? (
                <>
                  Found <b>{instructions.join(' and ')}</b> in {name}. Prompts tell agents to follow them
                  first; Forge never overrides a repository’s own instructions.
                </>
              ) : (
                <>
                  No AGENTS.md or CLAUDE.md in {name}. Prompts then use your project’s own guidance, set in
                  Settings.
                </>
              )}
            </Callout>
          }
          <div className="fx-panel fx-prompt-card">
            <div className="fx-prompt-head">
              <Segmented<BriefAgent>
                label="Agent"
                value={agent}
                onChange={setAgent}
                options={(['claude-code', 'codex', 'generic'] as const).map(id => ({
                  id,
                  label: agentNames[id],
                }))}
              />
              <Button
                size="sm"
                icon={copied ? 'passed' : 'copy'}
                onClick={() =>
                  void navigator.clipboard?.writeText(prompt.copyText).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="fx-prompt-title">{prompt.title}</div>
            <pre className="fx-prompt-preview">{prompt.copyText}</pre>
          </div>
        </div>
      </section>
    </>
  );
}
