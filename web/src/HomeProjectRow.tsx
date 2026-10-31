// SPDX-License-Identifier: Apache-2.0
import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { PortfolioProject, ProjectSummary } from './ProjectHomeData';
import { useWorkRecords, workIndex, type WorkIndexWorkspace } from './hosted-work-index';
import type { MoveRecord } from './cockpit/now-model';
import { latestAcceptedMain, selectedMain } from './shell/main-model';
import { age } from './ui/status';
import { useNow } from './shell/StatusBar';
export function HomeProjectRow({
  project,
  summary,
  starred,
  toggleStar,
  choose,
}: {
  project: PortfolioProject;
  summary?: ProjectSummary;
  starred: boolean;
  toggleStar: () => void;
  choose: () => void;
}) {
  const now = useNow();
  const counts = useQuery(api.projectCoordination.counts, { projectId: project.id });
  const raw = useQuery(workIndex.workspace, { projectId: project.id });
  const workspace = useMemo(() => (raw ? (JSON.parse(raw) as WorkIndexWorkspace) : null), [raw]);
  const local = useWorkRecords<MoveRecord & { head: string }>(project.id, workspace, 'channelMoves');
  const hosted = useWorkRecords<MoveRecord & { head: string }>(project.id, workspace, 'hostedChannels');
  const channels = useWorkRecords<{ name: string; head: string }>(project.id, workspace, 'channels');
  const selected = selectedMain(channels.records, hosted.records, workspace?.sourceKind);
  const main =
    selected &&
    latestAcceptedMain(
      workspace?.sourceKind === 'native'
        ? [...hosted.records, ...local.records]
        : [...local.records, ...hosted.records],
      selected,
    );
  const n = summary?.attention.length ?? 0;
  const working = counts ? counts.activeAgents + counts.activeSubagents + counts.activePeople : null;
  const actor = main?.actorDisplayName ?? main?.acceptedBy?.name;
  const named = actor && !/^(user_|contributor_)/.test(actor) ? actor : null;
  return (
    <div className="fx-home-row">
      <div>
        <button className="fx-home-name" title={project.name} onClick={choose}>
          {project.name}
        </button>
        <span className="fx-home-tag">hosted</span>
        {project.role && <span className="fx-home-tag">{project.role}</span>}
        <button
          className="fx-home-star"
          aria-label={`${starred ? 'Unstar' : 'Star'} ${project.name}`}
          aria-pressed={starred}
          title="Star in this browser"
          onClick={toggleStar}
        >
          {starred ? '★' : '☆'}
        </button>
        <div className="fx-home-fact">
          <b>main</b>
          {main ? (
            <span title={main.at}>
              {' '}
              · accepted {age(main.at, now)}
              {named ? ` by ${named}` : ''}
            </span>
          ) : summary?.loading ? (
            ' · reading…'
          ) : (
            ''
          )}
        </div>
      </div>
      <span className="fx-muted">
        {working === null ? '—' : working ? `${working} working` : 'No one now'}
      </span>
      {n ? (
        <button className="fx-home-needs" onClick={choose}>
          {n} need you
        </button>
      ) : (
        <span className="fx-muted">Quiet</span>
      )}
    </div>
  );
}
