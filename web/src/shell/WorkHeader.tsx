// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { Segmented } from '../ui/primitives';
export type WorkPage = 'intents' | 'lanes' | 'views' | 'planning' | 'decisions';
export type WorkCounts = Partial<Record<WorkPage, number>>;
export const WorkCountsContext = createContext<WorkCounts>({});
const pages = [
  { id: 'intents', label: 'Intents', glyph: 'intent' },
  { id: 'lanes', label: 'Lanes', glyph: 'lane' },
  { id: 'planning', label: 'Planning', glyph: 'initiative' },
  { id: 'decisions', label: 'Decisions', glyph: 'claim' },
] as const;
type Header = { page: WorkPage; counts: WorkCounts; onChange: (page: WorkPage) => void };
const Context = createContext<Header | null>(null);
export const useWorkHeader = () => useContext(Context);
/** Navigation consumes already loaded Work or workspace counts; never issues reads. */
export function WorkHeaderProvider({
  page,
  counts,
  onChange,
  children,
}: {
  page?: WorkPage;
  counts?: WorkCounts;
  onChange: (page: WorkPage) => void;
  children: ReactNode;
}) {
  const loaded = useContext(WorkCountsContext);
  return (
    <Context.Provider value={page ? { page, counts: counts ?? loaded, onChange } : null}>
      {children}
    </Context.Provider>
  );
}
export function InlineWorkNav({ header }: { header: Header }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [
    header.page,
    header.counts.intents,
    header.counts.lanes,
    header.counts.views,
    header.counts.planning,
    header.counts.decisions,
  ]);
  return (
    <nav ref={root} className="fx-work-nav" aria-label="Work pages">
      <Segmented
        value={header.page}
        label="Work views"
        onChange={header.onChange}
        options={pages.map(page => ({
          id: page.id,
          label: (
            <>
              <Glyph name={page.glyph} size={13} />
              <span>{page.label}</span>
              {header.counts[page.id] !== undefined && (
                <span className="fx-count">{header.counts[page.id]}</span>
              )}
            </>
          ),
        }))}
      />
    </nav>
  );
}
