// SPDX-License-Identifier: Apache-2.0
// Clerk stays behind owner-authorized actions; no public directory endpoint.
import { convexFetch, networkTimeout } from './networkFetch';
import { invariant } from '../src/errors';
type Person = {
  id: string;
  username?: string | null;
  email_addresses?: { email_address: string }[];
  external_accounts?: { provider?: string; username?: string | null }[];
};
/** Handle seeds: the chosen username and the GitHub login, never real names or emails. */
function handleSeed(person: Person | null) {
  const github = person?.external_accounts?.find(account => /github/.test(account.provider ?? ''))?.username;
  return {
    ...(person?.username ? { username: person.username } : {}),
    ...(github ? { githubLogin: github } : {}),
  };
}
async function clerk(path: string): Promise<unknown> {
  invariant(process.env.CLERK_SECRET_KEY, 'GITHUB_SETUP_REQUIRED', 'Forge identity is not configured.');
  const response = await convexFetch(`https://api.clerk.com/v1/users${path}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    redirect: 'error',
    signal: networkTimeout(30_000),
  });
  if (response.status === 404) return null;
  invariant(response.ok, 'GITHUB_UNAVAILABLE', 'Forge could not check this account. Try again.');
  return response.json();
}
export async function findPersonByEmail(value: string): Promise<Person | null> {
  const email = value.trim().toLowerCase();
  invariant(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    'BAD_ARGUMENT',
    'Enter the email address of an existing Forge account.',
  );
  const result = await clerk(`?${new URLSearchParams({ email_address: email })}`);
  invariant(Array.isArray(result), 'GITHUB_RESPONSE', 'Forge could not read the account lookup.');
  const matches = (result as Person[]).filter(
    person =>
      person.id && person.email_addresses?.some(address => address.email_address.toLowerCase() === email),
  );
  invariant(
    matches.length <= 1,
    'BAD_ARGUMENT',
    'No unique Forge account matches that email address. Ask your contributor which email they use for Forge.',
  );
  return matches[0] ?? null;
}
export async function personByEmail(value: string): Promise<Person> {
  const person = await findPersonByEmail(value);
  invariant(person, 'BAD_ARGUMENT', 'No Forge account matches that email address.');
  return person;
}
/** URL identity seeds deliberately omit every name and email field. */
export async function personUrlProfile(id: string) {
  const person = (await clerk(`/${encodeURIComponent(id)}`)) as Person | null;
  invariant(
    !person || person.id === id,
    'GITHUB_RESPONSE',
    'The identity provider returned another account.',
  );
  return handleSeed(person);
}

export async function urlProfilesPage(offset: number) {
  const people = await clerk(
    `?${new URLSearchParams({ limit: '25', offset: String(offset), order_by: '+created_at' })}`,
  );
  invariant(Array.isArray(people), 'GITHUB_RESPONSE', 'Forge could not read the account page.');
  return (people as Person[]).map(person => ({ owner: person.id, ...handleSeed(person) }));
}
