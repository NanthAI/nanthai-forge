// SPDX-License-Identifier: Apache-2.0
// The design system (Item 6ebb58ab): one token source, the shared parts and their rules (DESIGN.md). A screen opts in
// with data-ds on its root; legacy screens keep their own styles until stage C retires them route by route.
import './base.css';
import './core.css';
import './parts.css';

export { Avatar, Count, Glyph, ItemState, KindMark, State, Who, initials, stateWords } from './marks';
export type { ItemGlyph, Kind, StateKind, StateWord } from './marks';
export { useFirstStop } from './first-stop';
export { Band, Chip, CodeBox, Key, PhoneTabs, Prose, Region, Row, Standing, Table, useFold } from './parts';
export type { Column, KeyProps, RegionProps, StandingCell, StandingProps } from './parts';
export { Dock, Menu, Palette, ReorderList, Sheet, useDockLayout } from './interactive';
export type {
  DockLayout,
  DockProps,
  DockRegion,
  DockZone,
  MenuAction,
  PaletteEntry,
  PaletteGroup,
  ReorderItem,
} from './interactive';
export { loadLayer, prefetchLayerWhenIdle } from './layer';

export { Segment } from './Segment';
