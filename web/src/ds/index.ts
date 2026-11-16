// SPDX-License-Identifier: Apache-2.0
// The design system's static layer: tokens, base styles and drawn marks. Safe for first paint; no behaviour library.
// A screen built on the system renders inside an element with the data-ds attribute (DESIGN.md, "Using the system").
import './base.css';

export { Avatar, Count, Glyph, ItemState, KindMark, State, Who, initials, stateWords } from './marks';
export type { ItemGlyph, Kind, StateKind, StateWord } from './marks';
export { useFirstStop } from './first-stop';
