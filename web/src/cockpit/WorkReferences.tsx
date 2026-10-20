// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import type { CockpitWork } from './model';

type Kind = 'Lane' | 'Intent' | 'Candidate';
export type WorkReference = { id: string; kind: Kind; name: string; href: string };
export const WorkReferenceContext = createContext<readonly WorkReference[]>([]);

/** Only loaded records supply identities; a prefix must identify exactly one record. */
export function workReferences(
  work: Pick<CockpitWork, 'lanes' | 'intents' | 'views'>,
  links: Record<Kind, (id: string) => string>,
): WorkReference[] {
  return [
    ...work.lanes.map(lane => ({
      id: lane.id,
      kind: 'Lane' as const,
      name: lane.name,
      href: links.Lane(lane.id),
    })),
    ...work.intents.map(intent => ({
      id: intent.id,
      kind: 'Intent' as const,
      name: intent.outcome,
      href: links.Intent(intent.id),
    })),
    ...work.views.map(view => ({
      id: view.id,
      kind: 'Candidate' as const,
      name:
        view.inputs
          ?.map(input => work.lanes.find(lane => lane.id === input.laneId)?.name)
          .filter(Boolean)
          .join(' + ') || `Candidate ${view.id.slice(0, 8)}`,
      href: links.Candidate(view.id),
    })),
  ];
}

export function referenceParts(text: string, records: readonly WorkReference[]) {
  const pattern = /\b(?:(Lane|Intent|View|Candidate)\s+)?([0-9a-f]{8}[0-9a-f-]*)\b(?:-?…|\.{3})?/gi;
  const parts: (string | { id: string; reference?: WorkReference; kind?: Kind })[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const id = match[2]!;
    // Messages written before the rename still say View.
    const word = match[1]?.toLowerCase();
    const kind = word
      ? word === 'view'
        ? 'Candidate'
        : ((word[0]!.toUpperCase() + word.slice(1)) as Kind)
      : undefined;
    const candidates = records.filter(
      record =>
        (!kind || record.kind === kind) &&
        record.id.replaceAll('-', '').toLowerCase().startsWith(id.replaceAll('-', '').toLowerCase()),
    );
    const reference = candidates.length === 1 ? candidates[0] : undefined;
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
    if (!reference && !kind && !uuid) continue;
    parts.push(text.slice(offset, match.index), {
      id,
      ...(reference ? { reference } : {}),
      ...(kind ? { kind } : {}),
    });
    offset = match.index! + match[0].length;
  }
  parts.push(text.slice(offset));
  return parts;
}

/** Inline chips keep ids out of prose while preserving a full identity on hover. */
export function WorkText({ text }: { text: string }) {
  const records = useContext(WorkReferenceContext);
  return referenceParts(text, records).map((part, index): ReactNode => {
    if (typeof part === 'string') return part;
    const { reference, id } = part;
    const kind = reference?.kind ?? part.kind;
    const label = reference?.name.trim() || `${kind ? `${kind} ` : ''}${id.slice(0, 8)}`;
    const content = (
      <>
        {kind && <Glyph name={kind === 'Lane' ? 'lane' : kind === 'Intent' ? 'intent' : 'view'} size={11} />}
        <span>{label}</span>
      </>
    );
    return reference ? (
      <a
        key={index}
        className="fx-work-ref"
        href={reference.href}
        title={`${reference.kind}: ${reference.name || id} · ${reference.id}`}
      >
        {content}
      </a>
    ) : (
      <span key={index} className="fx-work-ref fx-work-ref-unknown" title={id}>
        {content}
      </span>
    );
  });
}
