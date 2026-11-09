// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Protected paths named per acceptance; the rest are counted in `pathsMore`. */
export const ACCEPTED_BY_PATHS = 20;

/** Who accepted a landing (Issue fe5bea80). `person`: a person accepted it (the project owner on the
 * review page or /approve, or their own web acceptance). `auto`: project policy accepted it after its
 * check passed and no person reviewed it. `actor` is stored as the account and leaves the server as
 * the public Forge handle (the public identity rule maps `actor`); readers who may not see people get
 * none. For `auto` it is the submitter. The submission's own `actor` is the submitter, not who
 * accepted it: an owner's agent and the owner share one account, so read this field to tell them
 * apart. `note` never names anyone. */
const acceptedByObject = z
  .object({
    kind: z.enum(['person', 'auto']),
    actor: z.string().min(1).optional(),
    /** person: when the person accepted; auto: when it landed. */
    at: z.iso.datetime(),
    /** person: the Candidate head the person accepted (absent for grants recorded before it was kept). */
    head: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** person: the protected paths in the change the person accepted (null: path coverage unavailable). */
    paths: z.array(z.string()).max(ACCEPTED_BY_PATHS).nullable().optional(),
    pathsMore: z.number().int().positive().optional(),
    /** person: main moved after the acceptance; identical source was checked again and landed with it. */
    carried: z.literal(true).optional(),
    /** Read from the receipt's actor: landed before acceptance stamps, so `at` is the landing time. */
    fromReceipt: z.literal(true).optional(),
    note: z.string().min(1),
  })
  .strict();
/** Rows stamped by the first release (2026-11-09, minutes) named the account `handle`, a key the
 * public identity rule does not map: reading renames it to `actor`, so it leaves as a handle. */
export const landingAcceptedBySchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || !('handle' in value)) return value;
  const { handle, ...rest } = value as Record<string, unknown>;
  return 'actor' in rest ? rest : { ...rest, actor: handle };
}, acceptedByObject);
export type LandingAcceptedBy = z.infer<typeof acceptedByObject>;

const short = (head: string) => head.slice(0, 8);
export const AUTO_ACCEPTED_NOTE =
  'Accepted automatically under project policy after its check passed; no person reviewed it.';

/** The stamp written once at publication, from facts the publish transaction already holds. */
export function landingAcceptedBy(input: {
  actor: { kind: 'person' | 'agent'; id: string };
  /** When it landed (ISO). */
  at: string;
  /** person: when they accepted (ms); defaults to `at`. */
  acceptedAt?: number | undefined;
  head?: string | undefined;
  protectedPaths?: string[] | null | undefined;
  carried?: boolean | undefined;
}): LandingAcceptedBy {
  if (input.actor.kind !== 'person')
    return { kind: 'auto', actor: input.actor.id, at: input.at, note: AUTO_ACCEPTED_NOTE };
  const at = input.acceptedAt === undefined ? input.at : new Date(input.acceptedAt).toISOString();
  const all = input.protectedPaths;
  const paths = all ? all.slice(0, ACCEPTED_BY_PATHS) : all;
  const more = all && all.length > ACCEPTED_BY_PATHS ? all.length - ACCEPTED_BY_PATHS : 0;
  const pathText =
    all === null
      ? '; path coverage unavailable'
      : all?.length
        ? `; protected paths ${paths!.join(', ')}${more ? ` +${more} more` : ''}`
        : '';
  return {
    kind: 'person',
    actor: input.actor.id,
    at,
    ...(input.head ? { head: input.head } : {}),
    ...(all !== undefined ? { paths } : {}),
    ...(more ? { pathsMore: more } : {}),
    ...(input.carried ? { carried: true as const } : {}),
    note: `A person accepted it at ${at}${input.head ? ` on Candidate ${short(input.head)}` : ''}${pathText}${
      input.carried
        ? '; main moved, so the same source was checked again and landed with that acceptance'
        : ''
    }.`,
  };
}

/** A landing stamped before acceptance stamps existed: the receipt's actor kind still tells a person's
 * acceptance from an automatic one; the acceptance time, head and paths were not kept. */
export function receiptAcceptedBy(receipt: {
  actor: { kind: 'person' | 'agent'; id: string };
  at: string;
}): LandingAcceptedBy {
  const by = landingAcceptedBy(receipt);
  return {
    ...by,
    fromReceipt: true,
    note:
      by.kind === 'person'
        ? `A person accepted it (from the receipt; the acceptance time was not kept, ${by.at} is the landing time).`
        : by.note,
  };
}

/** The line the CLI prints after LANDED: who, then the note. */
export function acceptedByLine(by: Pick<LandingAcceptedBy, 'kind' | 'actor' | 'note'>) {
  return by.kind === 'person'
    ? `ACCEPTED BY A PERSON${by.actor ? ` @${by.actor}` : ''}: ${by.note}`
    : `AUTO-ACCEPTED${by.actor ? ` (submitted by @${by.actor})` : ''}: ${by.note}`;
}
