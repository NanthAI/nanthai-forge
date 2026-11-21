// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './shell-quote.js';

/** Clone and device approval use the backend of the site that listed the project. */
export const publicProjectClone = (url: string, slug: string, deployment: string) =>
  `nforge clone ${shellQuote(url)} ${shellQuote(slug)} --deployment ${shellQuote(deployment)}`;

export const publicProjectLogin = (deployment: string) => `nforge login ${shellQuote(deployment)}`;
