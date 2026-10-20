// SPDX-License-Identifier: Apache-2.0
import { latestRun, type CockpitLane, type CockpitWork } from '../cockpit/model';
import type { GlyphName } from './Glyph';
import { age, attentionRank, type Tone } from './status';

/** One Lane row: the attention word and the fact line that says why (who, what, when). */
export type LaneFact = {
  tone: Tone;
  label: string;
  /** Pill glyph when it differs from the tone's default. */
  pillGlyph?: GlyphName;
  /** Who holds or last held the Lane; absent when nobody does. */
  who?: { name: string; kind: 'agent' | 'human'; identity: string };
  /** Status glyph before the text. */
  glyph?: GlyphName;
  text: string;
  detail?: string;
  /** The acceptance was automatic. */
  auto?: boolean;
  /** The Intent title, only when the Lane name says something different. */
  intent?: string;
  /** When the row last moved: closing time for closed Lanes, else last activity. */
  at?: string;
  open: boolean;
};

type Work = Omit<CockpitWork, 'channelMoves'> & {
  channelMoves?: readonly {
    channel: string;
    status?: string;
    head?: string;
    viewId: string;
    at?: string;
    acceptedBy?: { kind?: string; name: string };
    automatic?: unknown;
  }[];
};

const generic = (name: string | undefined): boolean => !name?.trim() || /^agent workflow$/i.test(name.trim());
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const sameTitle = (name: string, intent: string) => intent.startsWith(name) || name.startsWith(intent);
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** Fact lines for Lane rows (concept model §3), derived only from recorded Work and live sessions. */
export function laneFacts(
  work: Work,
  lanes: readonly CockpitLane[],
  now: number,
  hosted = false,
): Map<string, LaneFact> {
  const records = new Map(work.lanes.map(lane => [lane.id, lane]));
  const landings = (work.channelMoves ?? []).filter(
    move => move.channel === 'main' && (!move.status || move.status === 'accepted'),
  );
  const facts = new Map<string, LaneFact>();
  for (const lane of lanes) {
    const record = records.get(lane.id);
    const saves = lane.checkpoints;
    const lastSave = record?.lastCheckpointAt ?? record?.checkpoints?.at(-1)?.at;
    const started = record?.lifecycle?.[0]?.at ?? work.intents.find(i => i.id === lane.intentId)?.createdAt;
    const intent =
      lane.intent !== 'Unknown Intent' && !sameTitle(lane.name, lane.intent) ? lane.intent : undefined;
    const base = { ...(intent ? { intent } : {}), ...(lane.lastAt ? { at: lane.lastAt } : {}) };
    if (!lane.open) {
      const closed = record?.lifecycle?.filter(entry => entry.to === record.state).at(-1);
      if (record?.state === 'abandoned') {
        const by = closed?.actor?.name && !generic(closed.actor.name) ? ` by ${closed.actor.name}` : '';
        facts.set(lane.id, {
          ...base,
          ...(closed ? { at: closed.at } : {}),
          open: false,
          tone: 'stale',
          label: 'Abandoned',
          pillGlyph: 'failed',
          text: [
            `${hosted ? 'Closed without landing' : 'Abandoned'}${closed ? ` ${age(closed.at, now, true)}` : ''}${by}`,
            closed?.reason,
          ]
            .filter(Boolean)
            .join(' · '),
        });
        continue;
      }
      const views = work.views.filter(view =>
        (view.inputs ?? []).some(input => input.laneId === lane.id && input.head === lane.head),
      );
      const landing = landings
        .filter(move => views.some(view => view.id === move.viewId))
        .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
        .at(-1);
      const view = landing && views.find(item => item.id === landing.viewId);
      if (lane.accepted) {
        const width = view?.inputs?.length ?? 1;
        const by = landing?.acceptedBy?.name;
        facts.set(lane.id, {
          ...base,
          ...(landing?.at ? { at: landing.at } : closed ? { at: closed.at } : {}),
          open: false,
          tone: 'passed',
          label: 'Done',
          glyph: 'passed',
          text: [
            `Landed on main${landing?.at ? ` ${age(landing.at, now, true)}` : ''}`,
            view ? `Candidate of ${plural(width, 'Lane')}` : '',
            by ? `accepted by ${by}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          ...(landing?.automatic ? { auto: true } : {}),
        });
      } else
        facts.set(lane.id, {
          ...base,
          ...(closed ? { at: closed.at } : {}),
          open: false,
          tone: 'plain',
          label: 'Done',
          text: hosted
            ? 'Completed on owner machine'
            : `Closed without landing${closed ? ` ${age(closed.at, now, true)}` : ''}`,
          ...(hosted ? { detail: 'Landing details arrive with the next push' } : {}),
        });
      continue;
    }
    const holder =
      lane.session && lane.session.tone !== 'stale'
        ? {
            name: lane.session.name,
            kind: lane.session.person ? ('human' as const) : ('agent' as const),
            identity: lane.session.id ?? lane.session.name,
          }
        : undefined;
    const lastBy = lane.session?.name ?? (!generic(lane.startedBy?.name) ? lane.startedBy?.name : lane.owner);
    const named = holder ?? (lastBy ? { name: lastBy, kind: 'agent' as const, identity: lastBy } : undefined);
    const savesText = saves
      ? `${plural(saves, 'save')}${lastSave ? ` · last save ${age(lastSave, now, true)}` : ''}`
      : `No saves yet${started ? ` · started ${age(started, now, true)}` : ''}`;
    const run = lane.viewId ? latestRun(work.runs, lane.viewId) : undefined;
    const checkName = (run?.checkName ?? run?.check?.name)?.trim() || 'Check';
    if (lane.tone === 'conflict') {
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: 'conflict',
        label: lane.label,
        ...(named ? { who: named } : {}),
        glyph: 'conflict',
        text: lane.conflicts.length
          ? `${lane.conflicts.length === 1 ? lane.conflicts[0] : plural(lane.conflicts.length, 'file')} ${lane.conflicts.length === 1 ? 'conflicts' : 'conflict'} with main`
          : lane.fact,
      });
      continue;
    }
    if (lane.tone === 'running' && run) {
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: lane.tone,
        label: lane.label,
        ...(named ? { who: named } : {}),
        text: `${checkName} running${run.startedAt ? ` · ${age(run.startedAt, now)}` : ''}`,
      });
      continue;
    }
    if (lane.tone === 'passed' && run) {
      const at = run.endedAt ?? run.startedAt;
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: 'passed',
        label: lane.label,
        ...(named ? { who: named } : {}),
        glyph: 'check',
        text: `${checkName} passed${at ? ` ${age(at, now, true)}` : ''} · waiting for a person`,
      });
      continue;
    }
    if (lane.tone === 'failed' && run) {
      const summary = run.failureSummary
        ?.split('\n')
        .find(line => line.trim())
        ?.trim();
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: 'failed',
        label: lane.label,
        ...(named ? { who: named } : {}),
        text: [
          summary && summary.length <= 120 ? summary : lane.fact.replace(' · nobody’s on it', ''),
          holder ? `${holder.name} is on it` : 'nobody working',
        ].join(' · '),
      });
      continue;
    }
    if (lane.tone !== 'active') {
      // Queued, paused, superseded or cancelled checks keep the cockpit's own words.
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: lane.tone,
        label: lane.label,
        ...(named ? { who: named } : {}),
        text: lane.fact,
      });
      continue;
    }
    if (holder) {
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: 'active',
        label: 'Working',
        who: holder,
        text: savesText,
      });
      continue;
    }
    if (lane.session) {
      facts.set(lane.id, {
        ...base,
        open: true,
        tone: 'stale',
        label: 'Not seen',
        ...(named ? { who: named } : {}),
        text: `Not seen since ${clock(lane.session.lastSeen)} · ${saves ? plural(saves, 'save') : 'no saves'}`,
      });
      continue;
    }
    facts.set(lane.id, {
      ...base,
      open: true,
      tone: 'waiting',
      label: 'Waiting',
      glyph: 'person',
      text: [
        'Nobody working',
        lastSave
          ? `last save ${age(lastSave, now, true)}${lastBy ? ` by ${lastBy}` : ''}`
          : started
            ? `started ${age(started, now, true)}${lastBy ? ` by ${lastBy}` : ''}`
            : '',
        saves ? plural(saves, 'save') : 'no saves',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return facts;
}

export type LaneFilter = 'open' | 'ready' | 'done' | 'all';

/** Open · Ready · Done · All. Open and Ready sort by attention then recency; closed rows by closing time. */
export function filterLaneFacts<T extends { fact: LaneFact }>(rows: readonly T[], filter: LaneFilter): T[] {
  return rows
    .filter(({ fact }) =>
      filter === 'all'
        ? true
        : filter === 'done'
          ? !fact.open
          : filter === 'ready'
            ? fact.open && fact.tone === 'passed'
            : fact.open,
    )
    .sort(
      (a, b) =>
        Number(b.fact.open) - Number(a.fact.open) ||
        (a.fact.open ? attentionRank[a.fact.tone] - attentionRank[b.fact.tone] : 0) ||
        (b.fact.at ?? '').localeCompare(a.fact.at ?? ''),
    );
}
