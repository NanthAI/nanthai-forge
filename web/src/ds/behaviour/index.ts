// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The behaviour layer: the only folder that imports the headless library (scripts/ds-build-guard.mjs). It is loaded by
// ds/layer.ts on a route or a first press, plus one idle fetch, and never in the first-paint chunks.
import './layer.css';

export { ActionMenu, type ActionMenuProps, type MenuAction } from './Menu';
export { Sheet, type SheetProps } from './Dialog';
export { Palette, type PaletteEntry, type PaletteGroup, type PaletteProps } from './Palette';
export { ReorderList, dropIndex, type ReorderItem, type ReorderListProps } from './ReorderList';
export {
  Dock,
  moveRegion,
  zoneOf,
  type DockLayout,
  type DockProps,
  type DockRegion,
  type DockZone,
} from './Dock';
