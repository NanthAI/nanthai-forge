// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The project access contract (Item b987e608; docs/access.md): three roles, and what each may do. Pure data, shared by
// the server (convex/projectRole.ts resolves the role; each verb's enforcement point is listed in docs/access.md) and
// the People and access screen, which shows the same answers. The screen never decides access: every verb is
// enforced on the server, and this table is what the server tests assert.

/** A project member's role, GitHub's read / write / admin (owner). There is no maintainer role. */
export const projectRoles = ['owner', 'write', 'read'] as const;
export type ProjectRole = (typeof projectRoles)[number];
/** Who asks: a person in a browser session, or an agent acting through its person's approved device. */
type ProjectActorKind = 'person' | 'agent';
/** A viewer without a role: anyone on a public project, or nobody (a private project answers not found). */
type ProjectStanding = ProjectRole | 'public' | null;

type Least = ProjectRole | 'public';
/** How an agent's ask differs from its person's: the same, held for the person's approval, or never. */
type AgentRule = 'same' | 'held' | 'never';
type Verb = { least: Least; agents: AgentRule };

/** Every verb a role may use. Agents never get more than their person (rule: never more than their person). */
export const projectVerbs = {
  /** Code, history and the plan of a public project; clone and fork need a sign-in (public discovery). */
  readSource: { least: 'public', agents: 'same' },
  /** Lanes, receipts, check results and the project's live line. On a public project visitors read them too; which
   * Lane titles a visitor sees follows the project's opt-in (public discovery, 6a60e89a). */
  readWork: { least: 'public', agents: 'same' },
  /** The roster with handles. Readers see only themselves (public identity rule). */
  readPeople: { least: 'write', agents: 'same' },
  /** Full Work archives and checkpoints; reader grants and public visibility do not include them. */
  readArchives: { least: 'write', agents: 'same' },
  /** Start, save, sync and abandon one's own Lanes; edit the plan; comment. */
  changeWork: { least: 'write', agents: 'same' },
  /** Land one's own Lane with a passing check. */
  landWithCheck: { least: 'write', agents: 'same' },
  /** Land without a check: the owner, widened by the project policy to chosen people or all writers. */
  landWithoutCheck: { least: 'owner', agents: 'never' },
  /** Act on another member's Lanes and landings; recorded under the owner's account. */
  actOnOthersWork: { least: 'owner', agents: 'same' },
  /** Invite, add people or give read. A device asks its person, who approves on the approve page. */
  addPeople: { least: 'owner', agents: 'held' },
  /** Remove people, end invitations and lower write to read. Stays open to agents. */
  removePeople: { least: 'owner', agents: 'same' },
  /** Landing and checks policy, protected paths and other project settings. */
  changeSettings: { least: 'owner', agents: 'held' },
  /** Approve a held landing on a protected path (a team approver is proposed on 517523cf). */
  approveProtected: { least: 'owner', agents: 'never' },
  /** Secret values, permanent deletion and runner registration: the owner person, in a browser. */
  ownerPersonOnly: { least: 'owner', agents: 'never' },
} as const satisfies Record<string, Verb>;
type ProjectVerb = keyof typeof projectVerbs;
/** yes, held (an agent's ask waits for its person's approval) or no. */
type ProjectAnswer = 'yes' | 'held' | 'no';

const rank: Record<Least, number> = { public: 0, read: 1, write: 2, owner: 3 };

/** What `standing` may do with `verb`, as `kind`. `visibility` matters only for public verbs. */
export function projectMay(
  standing: ProjectStanding,
  verb: ProjectVerb,
  kind: ProjectActorKind,
  visibility: 'public' | 'private',
): ProjectAnswer {
  const rule: Verb = projectVerbs[verb];
  const level = standing === null ? -1 : rank[standing];
  const enough =
    rule.least === 'public'
      ? level >= 1 || (visibility === 'public' && level >= 0)
      : level >= rank[rule.least];
  if (!enough) return 'no';
  if (kind === 'person' || rule.agents === 'same') return 'yes';
  return rule.agents === 'held' ? 'held' : 'no';
}

/** Every answer for one viewer, as the People and access screen shows it. */
export function projectAnswers(
  standing: ProjectStanding,
  kind: ProjectActorKind,
  visibility: 'public' | 'private',
) {
  const out = {} as Record<ProjectVerb, ProjectAnswer>;
  for (const verb of Object.keys(projectVerbs) as ProjectVerb[])
    out[verb] = projectMay(standing, verb, kind, visibility);
  return out;
}
