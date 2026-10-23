// SPDX-License-Identifier: Apache-2.0
// Clerk stays behind owner-authorized actions; no public directory endpoint.
import { invariant } from '../src/errors';
type Person = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: { email_address: string }[];
};
async function clerk(path: string): Promise<unknown> {
  invariant(process.env.CLERK_SECRET_KEY, 'GITHUB_SETUP_REQUIRED', 'Forge identity is not configured.');
  const response = await fetch(`https://api.clerk.com/v1/users${path}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
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
export const personLabel = personDisplayName;

/** Project readers receive display names only, never email fallback. */
export async function personDisplayName(id: string) {
  const person = (await clerk(`/${encodeURIComponent(id)}`)) as Person | null;
  if (!person) return 'Account no longer available';
  invariant(person.id === id, 'GITHUB_RESPONSE', 'The identity provider returned another account.');
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || person.username;
  return name && !name.includes('@') ? name : 'Forge contributor';
}

/** URL identity seeds deliberately omit every email field. */
export async function personUrlProfile(id: string) {
  const person = (await clerk(`/${encodeURIComponent(id)}`)) as Person | null;
  invariant(
    !person || person.id === id,
    'GITHUB_RESPONSE',
    'The identity provider returned another account.',
  );
  return {
    ...(person?.username ? { username: person.username } : {}),
    ...(person?.first_name ? { firstName: person.first_name } : {}),
    ...(person?.last_name ? { lastName: person.last_name } : {}),
  };
}

export async function urlProfilesPage(offset: number) {
  const people = await clerk(
    `?${new URLSearchParams({ limit: '25', offset: String(offset), order_by: '+created_at' })}`,
  );
  invariant(Array.isArray(people), 'GITHUB_RESPONSE', 'Forge could not read the account page.');
  return (people as Person[]).map(person => ({
    owner: person.id,
    ...(person.username ? { username: person.username } : {}),
    ...(person.first_name ? { firstName: person.first_name } : {}),
    ...(person.last_name ? { lastName: person.last_name } : {}),
  }));
}
