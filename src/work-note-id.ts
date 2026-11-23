// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { digest } from './state/hash.js';
export const noteId = (intentId: string, index: number) => {
  const h = digest(`intent-merge-v1:note:${intentId}:${index}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
