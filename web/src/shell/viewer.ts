// SPDX-License-Identifier: Apache-2.0
import { useUser } from '@clerk/react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
/** The signed-in viewer's Forge handle: how every hosted read names this person. It shares
 * the account subscription the shell already holds (same query and arguments), so no call is added. */
export function useViewerHandle(): string | undefined {
  const { isSignedIn } = useUser();
  return useQuery(api.urlAccounts.current, isSignedIn ? {} : 'skip')?.handle;
}
type ClerkUser =
  | {
      username?: string | null;
      externalAccounts?: readonly { provider?: string; username?: string | null }[];
    }
  | null
  | undefined;
/** What a default handle may come from: the chosen username, else the GitHub login. */
export function handleSeed(user: ClerkUser): { username?: string; githubLogin?: string } {
  const github = user?.externalAccounts?.find(account => /github/.test(account.provider ?? ''))?.username;
  return {
    ...(user?.username ? { username: user.username } : {}),
    ...(github ? { githubLogin: github } : {}),
  };
}
