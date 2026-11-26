// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { shellQuote } from './shell-quote.js';

/** Full addresses keep copied commands bound to the instance that generated them. */
export const publicProjectClone = (url: string, directory: string) =>
  `nforge clone ${shellQuote(url)} ${shellQuote(directory)}`;

export const publicProjectLogin = (site: string) => `nforge login ${shellQuote(site)}`;
