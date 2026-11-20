// SPDX-License-Identifier: Apache-2.0
// One main red (Item ae068e0c): the view a Main broke or Drill row's Why opens. The head says where main failed, which
// landing broke it (or that the landings since the last pass are candidates) and how it ended; the left column is
// what failed and the log, one press away; the right is the landings since the last pass, each linking to its receipt
// in What landed, and the run's facts. One subscription (convex/projectMainRed.ts read), re-run only when a row it read
// is written; the log is read once per press (web/src/lane/landing-output.ts), never on a timer.
import { useMemo, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Glyph, Key, Region, Row, State } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { hostedError } from '../../snapshot';
import { landingBrowserIO } from '../../lane/landing-browser-io';
import { landingFailureExcerpt } from '../../lane/landing-output';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head } from '../Place';
import type { PlaceProps } from '../screen-route';
import {
  agentCommand,
  clock,
  endLine,
  endState,
  named,
  plural,
  redSentence,
  short,
  titleOf,
  whoOf,
  type RedRead,
} from './red-model';
import { redSequenceOf } from './route';
import '../check/check.css';
import './red.css';

export default function MainRed({ route, projectId, projectName }: PlaceProps) {
  const sequence = redSequenceOf(route) ?? 0;
  const { value, error } = useSafeQuery(api.projectMainRed.read, { projectId, sequence });
  const read = value ? (JSON.parse(value) as RedRead) : null;
  const at = (patch: Partial<typeof route>) => hrefFor({ ...route, ...patch });
  const trail = [
    { label: projectName, href: at({ place: 'needs', section: '', rest: '' }) },
    { label: 'Code', href: at({ section: '', rest: '' }) },
    { label: read?.red?.drill ? 'Drill' : 'Main broke' },
  ];
  if (error) return <Head trail={trail} sentence="Forge could not read this red. Nothing on main changed." />;
  if (!read) return <Head trail={trail} sentence="Reading why main failed…" />;
  if (!read.red)
    return (
      <Head
        trail={trail}
        sentence="This red is no longer on record. Main's newest audits are in Settings, Landing and checks."
      >
        <A className="btn sm" href={at({ place: 'settings', section: 'checks', rest: '' })}>
          Open Landing and checks
        </A>
      </Head>
    );
  return <RedView read={read} trail={trail} projectId={projectId} receipt={id => at({ rest: id })} />;
}

export function RedView({
  read,
  trail,
  projectId,
  receipt,
}: {
  read: RedRead;
  trail: { label: string; href?: string }[];
  projectId: Id<'hostedProjects'>;
  receipt: (receiptId: string) => string;
}) {
  const client = useConvex();
  const io = useMemo(() => landingBrowserIO(client, projectId), [client, projectId]);
  const [log, setLog] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [cli, setCli] = useState(false);
  const red = read.red!;
  const ended = endState(read);
  const sentence = redSentence(read);
  const readLog = () => {
    if (log !== null) return setLog(null);
    if (reading) return;
    setReading(true);
    setFailed(null);
    void landingFailureExcerpt(io, red.runId)
      .then(value => setLog(value.log))
      .catch(error =>
        setFailed(`The log did not load: ${hostedError(error)} The verdict is Forge's own record.`),
      )
      .finally(() => setReading(false));
  };
  return (
    <>
      <Head
        trail={trail}
        sentence={
          <>
            <b>{sentence.lead}</b> {sentence.rest}
          </>
        }
      >
        <span className="red-end">
          <State word={ended.word} state={ended.st}>
            {ended.text}
          </State>
        </span>
        {read.culprit ? (
          <A className="btn sm" href={receipt(read.culprit.receiptId)}>
            Open the landing that broke it
          </A>
        ) : read.newlyCoveredBy ? (
          <A className="btn sm" href={receipt(read.newlyCoveredBy.receiptId)}>
            Open the landing that made tests run
          </A>
        ) : null}
        <Key kind="ghost" aria-expanded={log !== null} onClick={readLog}>
          {reading && log === null ? 'Reading the log…' : log !== null ? 'Hide the log' : 'Read the log'}
        </Key>
        {read.runLink ? (
          <a className="btn sm ghost" href={read.runLink} target="_blank" rel="noreferrer">
            Full log at your CI
          </a>
        ) : null}
        <button
          type="button"
          className="cli"
          aria-controls="red-cli"
          aria-expanded={cli}
          title="What an agent gets"
          onClick={() => setCli(open => !open)}
        >
          <span className="mono">nforge agent . status</span>
        </button>
      </Head>
      <pre className="cli-out mono" id="red-cli" hidden={!cli}>
        {agentCommand(read)}
      </pre>
      {failed ? (
        <div className="notice" data-st="failed" role="status">
          <p>{failed}</p>
        </div>
      ) : null}
      <div className="panes chk-p">
        <section className="pane" aria-label="Evidence">
          <Failed read={read} />
          {log !== null ? (
            <Region title="The log" hint="the failing output, as your CI sent it">
              <pre className="out mono" tabIndex={0}>
                {log || 'Your CI sent no output for this run.'}
              </pre>
            </Region>
          ) : null}
          <Region title="How it ended" quiet>
            <p className="quietline">{endLine(read)}</p>
            {read.end?.how === 'recovered' && read.end.by ? (
              <p className="quietline">
                <A href={receipt(read.end.by.landing.receiptId)}>
                  {read.end.by.kind === 'revert' ? 'Open the revert' : 'Open that landing'}
                </A>
              </p>
            ) : null}
          </Region>
        </section>
        <section className="pane side" aria-label="Which landing">
          <Landings read={read} receipt={receipt} />
          <Facts read={read} />
        </section>
      </div>
    </>
  );
}

function Failed({ read }: { read: RedRead }) {
  const run = read.run;
  const live = read.end?.how === 'red' ? read.end : null;
  const failing = run?.failed.length
    ? run.failed
    : (live?.tests ?? []).map(file => ({ file, firstError: undefined }));
  const count = run?.files.failed ?? failing.length + (live?.moreTests ?? 0);
  if (!failing.length)
    return (
      <Region title="What failed" hint="reported by your CI">
        {run?.failureReason ? (
          <pre className="out mono" tabIndex={0}>
            {run.failureReason}
          </pre>
        ) : (
          <p className="quietline">Which tests failed is not reported. The log may say.</p>
        )}
      </Region>
    );
  return (
    <Region
      title="What failed"
      count={count}
      hint={count > failing.length ? `${failing.length} of ${count}` : 'reported by your CI'}
    >
      {failing.map(item => (
        <Row key={item.file} cols="auto minmax(0, 1fr)" className="ffile">
          <span className="st" data-st="failed">
            <Glyph of="failed" />
          </span>
          <span className="any">
            <span className="ttl mono cut" dir="auto" title={item.file}>
              {item.file}
            </span>
            {item.firstError ? <span className="meta wrap2">{item.firstError}</span> : null}
          </span>
        </Row>
      ))}
    </Region>
  );
}

function Landings({ read, receipt }: { read: RedRead; receipt: (id: string) => string }) {
  const landings = read.landings ?? [];
  const culprit = read.culprit?.receiptId ?? null;
  const covered = read.newlyCoveredBy?.receiptId ?? null;
  const known = culprit ?? covered;
  return (
    <Region
      title={known ? 'Since main last passed' : 'Candidates'}
      count={landings.length}
      hint={
        culprit
          ? 'the bisect proved which one'
          : covered
            ? 'one made the tests run'
            : read.landingsMore
              ? 'not proven; the newest'
              : 'not proven'
      }
    >
      {landings.length ? (
        landings.map(landing => {
          const broke = landing.receiptId === culprit;
          const who = whoOf(landing);
          return (
            <A key={landing.receiptId} className="row red-landing" href={receipt(landing.receiptId)}>
              <span className="num t2 mono">{clock(landing.at)}</span>
              <span className="any">
                <span className={`ttl${landing.title ? '' : ' none'}`} dir="auto">
                  {titleOf(landing)}
                </span>
                {who ? <span className="meta">{who}</span> : null}
              </span>
              {broke ? (
                <State word="Check failed">Broke main</State>
              ) : landing.receiptId === covered ? (
                <span className="t2">Made tests run</span>
              ) : (
                <span className="t2">{known ? '' : 'Candidate'}</span>
              )}
            </A>
          );
        })
      ) : (
        <p className="quietline">No landing since the last pass is on record.</p>
      )}
      {read.culprit && !landings.some(landing => landing.receiptId === culprit) ? (
        <p className="quietline">
          The bisect proved{' '}
          <A href={receipt(read.culprit.receiptId)}>
            {read.culprit.landing ? `“${titleOf(read.culprit.landing)}”` : read.culprit.receiptId.slice(0, 8)}
          </A>{' '}
          broke it.
        </p>
      ) : null}
      {read.newlyCoveredBy && !landings.some(landing => landing.receiptId === covered) ? (
        <p className="quietline">
          <A href={receipt(read.newlyCoveredBy.receiptId)}>{named(read.newlyCoveredBy)}</A> made the failing
          tests run.
        </p>
      ) : null}
    </Region>
  );
}

function Facts({ read }: { read: RedRead }) {
  const red = read.red!;
  return (
    <Region title="Facts" quiet>
      <dl className="kv">
        <dt>main</dt>
        <dd className="mono">{short(red.head)}</dd>
        <dt>Failed</dt>
        <dd className="num">{clock(red.at)}</dd>
        <dt>{read.lastGreen?.audited ? 'Last audit pass' : 'Last pass'}</dt>
        <dd className="mono">
          {read.lastGreen ? (
            [short(read.lastGreen.head), read.lastGreen.at === null ? '' : clock(read.lastGreen.at)]
              .filter(Boolean)
              .join(', ')
          ) : (
            <span className="t2">not reported</span>
          )}
        </dd>
        <dt>Tests</dt>
        <dd className="num">
          {read.run?.files.total ? (
            `${plural(read.run.files.failed ?? 0, 'file')} failed of ${read.run.files.total.toLocaleString('en')}`
          ) : (
            <span className="t2">not reported</span>
          )}
        </dd>
        <dt>Run</dt>
        <dd className="mono cut">{red.runId.slice(0, 8)}</dd>
      </dl>
    </Region>
  );
}
