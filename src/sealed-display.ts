// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { displayText } from './sealed-records.js';
/** Terminal output is derived from verified names, with control/escape bytes removed. */
export const safeSecretName = (name: string) => name.replace(/[^A-Z0-9_]/g, '?').slice(0, 64);
/** A name someone gave (a computer or CI machine) is shown after control, escape and direction-override characters are
 * removed and the length is bounded; servers and rosters supply it, so it is cleaned where it is printed. */
export const safeLabel = (name: string) => displayText(name);
