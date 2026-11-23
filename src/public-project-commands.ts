// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { shellQuote } from './shell-quote.js';

/** Clone and device approval use the backend of the site that listed the project. */
export const publicProjectClone = (url: string, slug: string, deployment: string) =>
  `nforge clone ${shellQuote(url)} ${shellQuote(slug)} --deployment ${shellQuote(deployment)}`;

export const publicProjectLogin = (deployment: string) => `nforge login ${shellQuote(deployment)}`;
