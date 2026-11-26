// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { deploymentUrl } from './deployment-origin.js';

/** Distribution default, used before this CLI has a saved instance. */
export const defaultForgeSite = 'https://dev.forge.nanthai.tech';
export const cliDiscoveryPath = '/_forge/cli.json';

export const distributionForgeSite = (site = process.env.FORGE_SITE_URL) =>
  site ? deploymentUrl(site) : defaultForgeSite;
