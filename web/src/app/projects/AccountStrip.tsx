// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The strip above the Projects place: Projects | Trash (DESIGN.md rule 8, SPEC-01-trash). Sections of one place are a
// strip, never tabs inside a region. Trash has its own address so it can be linked and reloaded.
import { A } from '../frames';
import { hrefFor } from '../paths';

export const trashHref = `${hrefFor({ frame: 'account', place: 'projects' })}?view=trash`;

export function AccountStrip({ current }: { current: 'projects' | 'trash' }) {
  return (
    <nav className="strip account-strip" aria-label="Projects">
      <A
        href={hrefFor({ frame: 'account', place: 'projects' })}
        aria-current={current === 'projects' ? 'page' : undefined}
      >
        Projects
      </A>
      <A href={trashHref} aria-current={current === 'trash' ? 'page' : undefined}>
        Trash
      </A>
    </nav>
  );
}
