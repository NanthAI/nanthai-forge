// SPDX-License-Identifier: Apache-2.0
import { useRef } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { inviteToTeam } from './team-invite';

type Attempts = Parameters<typeof inviteToTeam>[1];

/** Invite to a team by Forge handle or address; the result is 'pending' or null (already on the team). */
export function useTeamInvite() {
  const client = useConvex();
  const attempts = useRef<Attempts>(new Map());
  return inviteToTeam<Id<'teams'>>(
    {
      handle: args => client.action(api.teamActions.addMember, args),
      email: args => client.action(api.teamActions.addByEmail, args),
    },
    attempts.current,
  );
}
