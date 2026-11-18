// SPDX-License-Identifier: Apache-2.0
// The end of connecting CI (Item 0c9207b8): whether the chosen check has decided a landing yet. One read when the page
// opens with a check chosen (projectHostedLandings.read: the first FIRST_LANDINGS_READ landings since the choice, a
// few indexed rows each), no subscription. While none is checked and the check is a CI file, the first page of that
// one file says whether main's copy runs on Forge's branches; if not, the exact change is shown once with the prompt
// that hands it to an agent. After the first checked landing none of this is drawn or read.
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Row } from '../../ds';
import { CommandBlock, CopyKey } from '../start/parts';
import type { SetupView } from '../start/setup-model';
import type { LineFeed } from '../Line';
import { triggerLine } from './choose-ci';
import {
  awaiting,
  FIRST_LANDINGS_READ,
  firstChecked,
  firstRunPrompt,
  type LandingRow,
} from './first-landing';
import { Change } from './OwnFile';
import { useWorkflowTrigger } from './use-workflows';

type ProjectId = Id<'hostedProjects'>;
type Check = NonNullable<SetupView['check']>;
const landingsRef = makeFunctionReference<
  'query',
  { projectId: ProjectId; from: string; to: string; limit: number },
  string
>('projectHostedLandings:read');

/** The first landing this check decided: undefined while reading, 'failed' when the read failed, null when none. */
export function useFirstChecked(projectId: ProjectId, chosenAt: number | undefined, revision: number) {
  const client = useConvex();
  const [answer, setAnswer] = useState<ReturnType<typeof firstChecked> | 'failed'>();
  useEffect(() => {
    if (chosenAt === undefined) return;
    let live = true;
    setAnswer(undefined);
    void client
      .query(landingsRef, {
        projectId,
        from: new Date(chosenAt).toISOString(),
        to: new Date(Math.max(Date.now(), chosenAt) + 60_000).toISOString(),
        limit: FIRST_LANDINGS_READ,
      })
      .then(text => (JSON.parse(text) as { landings?: LandingRow[] }).landings ?? [])
      .then(
        landings => live && setAnswer(firstChecked(landings)),
        () => live && setAnswer('failed'),
      );
    return () => {
      live = false;
    };
  }, [client, projectId, chosenAt, revision]);
  return chosenAt === undefined ? undefined : answer;
}

/** Drawn only while no landing has been checked by the chosen check. */
export function AwaitingFirstLanding(props: {
  projectId: ProjectId;
  project: string;
  check: Check;
  feed: LineFeed | undefined;
}) {
  const { check, feed } = props;
  const path = check.kind === 'ci-file' ? check.workflow : null;
  const trigger = useWorkflowTrigger(props.projectId, feed?.main?.head, path);
  const checking = feed?.lanes?.filter(lane => lane.stage === 'checking').length ?? 0;
  const { meta, needsLine } = awaiting({ check, checking, trigger });
  const change = trigger?.kind === 'push' ? trigger.change : null;
  return (
    <>
      <Row cols="minmax(0, 1fr) auto">
        <div>
          <div className="ttl">No landing checked yet</div>
          <div className="meta" dir="auto">
            {meta}
          </div>
        </div>
        {needsLine && path ? (
          <CopyKey
            text={firstRunPrompt(props.project, path, change)}
            label="Give this to your agent"
            kind="rec"
            size="sm"
          />
        ) : null}
      </Row>
      {needsLine && path ? (
        <div className="pad gs-stack">
          {change ? (
            <Change path={path} change={change} />
          ) : (
            <CommandBlock label="The trigger the CI file needs" text={triggerLine} />
          )}
        </div>
      ) : null}
    </>
  );
}
