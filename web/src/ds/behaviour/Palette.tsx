// SPDX-License-Identifier: Apache-2.0
// Go to or run (⌘K): the only Autocomplete in the app (a release-candidate part, pinned with the layer's exact version;
// tests/ds-build-guard.test.mjs keeps it to this file). Typing filters; the first match is ready for Enter. With an empty
// search nothing is chosen, so Enter runs nothing.
import type { ReactNode } from 'react';
import {
  Autocomplete,
  Dialog,
  Header,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  useFilter,
} from 'react-aria-components';
import { EnglishOnly } from './shared';

export type PaletteEntry = {
  id: string;
  label: string;
  /** What typing matches, when more than the label (an id result matches its full id). */
  text?: string;
  lead?: ReactNode;
  keys?: string;
  onAction: () => void;
};
export type PaletteGroup = { title: string; entries: readonly PaletteEntry[] };

export type PaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly PaletteGroup[];
  placeholder?: string;
  /** Every change of the search text, for results that depend on it (an id lookup). */
  onInputChange?: (text: string) => void;
  /** What the list says when nothing matches (an id lookup on its way says so). */
  empty?: string;
};

export function Palette({
  open,
  onOpenChange,
  groups,
  placeholder = 'Go to a Lane, Item, file or command…',
  onInputChange,
  empty = 'Nothing matches.',
}: PaletteProps) {
  const { contains } = useFilter({ sensitivity: 'base' });
  const entries = new Map(groups.flatMap(group => group.entries.map(entry => [entry.id, entry] as const)));
  return (
    <EnglishOnly>
      <ModalOverlay className="scrim pal-scrim" isOpen={open} onOpenChange={onOpenChange} isDismissable>
        <Modal className="sheet pal">
          <Dialog aria-label="Go to or run" className="ds-dialog">
            {/* A pasted id often carries a space or a line break; it still matches. */}
            <Autocomplete
              filter={(text, input) => contains(text, input.trim())}
              {...(onInputChange ? { onInputChange } : {})}
            >
              <SearchField aria-label="Search" autoFocus className="pal-find">
                <Input className="pal-in" placeholder={placeholder} />
              </SearchField>
              <Menu
                className="pal-list"
                aria-label="Results"
                onAction={key => {
                  onOpenChange(false);
                  entries.get(String(key))?.onAction();
                }}
                renderEmptyState={() => <div className="pal-none">{empty}</div>}
              >
                {groups.map(group => (
                  <MenuSection key={group.title} className="pal-grp">
                    <Header>{group.title}</Header>
                    {group.entries.map(entry => (
                      <MenuItem
                        key={entry.id}
                        id={entry.id}
                        textValue={entry.text ?? entry.label}
                        className="opt"
                      >
                        {entry.lead}
                        <span className="cut">{entry.label}</span>
                        {entry.keys ? <kbd aria-hidden="true">{entry.keys}</kbd> : null}
                      </MenuItem>
                    ))}
                  </MenuSection>
                ))}
              </Menu>
            </Autocomplete>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </EnglishOnly>
  );
}
