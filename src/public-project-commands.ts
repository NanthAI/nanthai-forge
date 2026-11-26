// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { shellQuote } from './shell-quote.js';
import { defaultForgeSite } from './forge-site.js';

/** On the built-in site the project name is enough. Other sites keep their full address. */
export function publicProjectClone(url: string, directory: string) {
  const address = new URL(url);
  const [owner, project] = address.pathname.split('/').filter(Boolean);
  const source = address.origin === defaultForgeSite && owner && project ? `${owner}/${project}` : url;
  return `nforge clone ${shellQuote(source)} ${shellQuote(directory)}`;
}

export const publicProjectLogin = (site: string) =>
  site === defaultForgeSite ? 'nforge login' : `nforge login ${shellQuote(site)}`;
