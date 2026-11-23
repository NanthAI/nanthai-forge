// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

/** What Stats prices saved CI minutes at: GitHub's list price for a standard GitHub-hosted Linux runner (2-core x64,
 * the size `ubuntu-latest` runs on), per minute in US dollars. Read from GitHub's official runner pricing page on
 * `STATS_RATE_READ_ON`; the page lists no effective date of its own. Shown for every plan and for public repositories
 * too, as what the minutes would cost a private repository at list price (owner decision 2026-11-23). Update this one
 * constant and its date together when GitHub changes the rate. */
export const STATS_USD_PER_RUNNER_MINUTE = 0.006;
export const STATS_RATE_READ_ON = '2026-11-23';
export const STATS_RATE_SOURCE = 'https://docs.github.com/en/billing/reference/actions-runner-pricing';
export const STATS_RATE_RUNNER = 'standard Linux 2-core';

/** Dollars at list price for runner minutes. */
export const minutesToUsd = (minutes: number) => minutes * STATS_USD_PER_RUNNER_MINUTE;
