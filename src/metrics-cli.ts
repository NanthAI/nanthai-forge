// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { invariant } from './errors.js';
import { readMetricRecords } from './self-metrics-source.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { formatMetrics, formatMetricReport } from './self-metrics-format.js';
import { recordBillCli } from './metrics-bill-cli.js';
import { metricAddress, metricQuery } from './self-metrics-source.js';
import { nameFlakeIssues } from './self-metrics-flake-issues.js';
import { pageMetrics, METRICS_PAGE_MAX, METRICS_CONTEXT_DAYS_MAX } from './self-metrics-page.js';
export async function metricsCli(args: string[]) {
  if (args[0] === 'record-bill') return recordBillCli(args.slice(1));
  if (!args.length || args[0] === '--help') {
    process.stdout.write(
      'nforge metrics ROOT [--from DATE] [--to DATE] [--json | --text] [--report FILE.md] [--compare FROM..TO] [--limit N] [--cursor C] [--context-days N] [--flake-issues]\nnforge metrics ROOT --failures [--from DATE] [--to DATE] [--text] [--checks [--limit N] [--cursor C] [--noise TAG]]\nnforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N [...]\nUTC windows are [from,to). JSON is the default for agents/non-TTY output.\n--limit N pages the report row lists (N entries per list; follow page.nextCursor with --cursor C, same window); per-day rows are omitted when paging.\n--context-days N (0 to 30, default 2) sets the days of pre-window history read to classify landings; the window and this horizon bound the read.\n--flake-issues prints only the flaky-file list, each with its Issue.\n--failures prints the health report: failed operations and landings in the window counted by code, with first and last time, median time to fail and the latest message (one bounded read; default window the last 7 days).\n--failures --checks lists failed checks instead, newest first: operation id, code, failing test files or static step, first error and a noise tag (runner, budget, flake, real, unknown), N per page (default 20, up to 100; follow nextCursor with --cursor C), --noise TAG keeps one tag. One read of at most 500 rows.\n',
    );
    return;
  }
  const [owner, ...flags] = args;
  invariant(owner && !owner.startsWith('--'), 'BAD_ARGUMENT', 'Metrics requires ROOT.');
  const options: Record<string, string> = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    invariant(
      [
        '--from',
        '--to',
        '--compare',
        '--report',
        '--json',
        '--text',
        '--flake-issues',
        '--failures',
        '--checks',
        '--noise',
        '--limit',
        '--cursor',
        '--context-days',
      ].includes(flag) && !(flag in options),
      'BAD_ARGUMENT',
      'Unknown or repeated metrics option.',
    );
    if (
      flag === '--json' ||
      flag === '--text' ||
      flag === '--flake-issues' ||
      flag === '--failures' ||
      flag === '--checks'
    )
      options[flag] = 'true';
    else {
      const value = flags[++i];
      invariant(value && !value.startsWith('--'), 'BAD_ARGUMENT', `${flag} requires a value.`);
      options[flag] = value;
    }
  }
  invariant(!(options['--json'] && options['--text']), 'BAD_ARGUMENT', 'Choose --json or --text.');
  const period = metricPeriod(options['--from'], options['--to']);
  const compare = options['--compare']?.split('..');
  invariant(
    !compare || (compare.length === 2 && compare.every(Boolean)),
    'BAD_ARGUMENT',
    'Use --compare FROM..TO.',
  );
  const beforePeriod = compare ? metricPeriod(compare[0], compare[1]) : undefined;
  const limit = options['--limit'] === undefined ? undefined : Number(options['--limit']);
  invariant(
    limit === undefined || (Number.isInteger(limit) && limit >= 1 && limit <= METRICS_PAGE_MAX),
    'BAD_ARGUMENT',
    `--limit must be a whole number from 1 to ${METRICS_PAGE_MAX}.`,
  );
  const contextDays = options['--context-days'] === undefined ? undefined : Number(options['--context-days']);
  invariant(
    contextDays === undefined ||
      (Number.isFinite(contextDays) && contextDays >= 0 && contextDays <= METRICS_CONTEXT_DAYS_MAX),
    'BAD_ARGUMENT',
    `--context-days must be a finite number from 0 to ${METRICS_CONTEXT_DAYS_MAX}.`,
  );
  invariant(
    !options['--cursor'] || limit !== undefined || options['--checks'] !== undefined,
    'BAD_ARGUMENT',
    '--cursor needs --limit, the same as its first page.',
  );
  invariant(
    !(options['--flake-issues'] && (limit !== undefined || options['--compare'])),
    'BAD_ARGUMENT',
    '--context-days N (0 to 30, default 2) sets the days of pre-window history read to classify landings; the window and this horizon bound the read.\n--flake-issues prints only the flake list; do not combine it with --limit or --compare.',
  );
  invariant(
    !(options['--checks'] || options['--noise']) || options['--failures'],
    'BAD_ARGUMENT',
    '--checks and --noise go with --failures.',
  );
  if (options['--failures']) {
    const checks = options['--checks'] !== undefined;
    invariant(
      limit === undefined || !checks || limit <= 100,
      'BAD_ARGUMENT',
      '--limit with --checks is at most 100.',
    );
    invariant(
      (limit === undefined || checks) &&
        !compare &&
        !options['--flake-issues'] &&
        !options['--report'] &&
        contextDays === undefined &&
        (checks || (!options['--cursor'] && !options['--noise'])),
      'BAD_ARGUMENT',
      '--failures takes --from, --to, --json or --text, and with --checks also --limit, --cursor and --noise.',
    );
    const address = metricAddress(owner).address;
    invariant(
      address,
      'BAD_ARGUMENT',
      'The failure report reads a hosted project; run it from a hosted checkout.',
    );
    // One query: the bounded failure-log read (convex/projectFailureReport.ts).
    const failures: unknown = JSON.parse(
      String(
        await metricQuery(address)('projectFailureReport:report', {
          from: period.from,
          to: period.to,
          ...(checks
            ? {
                checks: {
                  limit: limit ?? 20,
                  ...(options['--cursor'] ? { cursor: options['--cursor'] } : {}),
                  ...(options['--noise'] ? { noise: options['--noise'] } : {}),
                },
              }
            : {}),
        }),
      ),
    );
    if (options['--text']) process.stdout.write(JSON.stringify(failures, null, 2) + '\n');
    else return failures;
    return;
  }
  const result = metricsSurface(
    await readMetricRecords(
      owner,
      period,
      options['--flake-issues'] ? { runsOnly: true, contextDays } : { contextDays },
    ),
    period,
  );
  // Opt-in: one planning search per listed flaky file (at most 10). Reads add no calls by default.
  if (options['--flake-issues'] && result.totals.flakes.files.length) {
    const address = metricAddress(owner).address;
    if (address) await nameFlakeIssues(metricQuery(address), result.totals.flakes.files);
  }
  const before = beforePeriod
    ? metricsSurface(await readMetricRecords(owner, beforePeriod, { contextDays }), beforePeriod)
    : undefined;
  if (options['--report'])
    writeFileSync(options['--report'], formatMetricReport(result, before), { mode: 0o600 });
  if (options['--flake-issues']) {
    const flakes = {
      schema: 1,
      period,
      ...(result.source ? { source: result.source } : {}),
      flakes: result.totals.flakes,
    };
    if (options['--text']) process.stdout.write(JSON.stringify(flakes, null, 2) + '\n');
    else return flakes;
    return;
  }
  if (options['--json'] || (!options['--text'] && !process.stdout.isTTY)) {
    const shown = pageMetrics(result, period, { limit, cursor: options['--cursor'] });
    return before ? { ...shown, compare: before } : shown;
  }
  process.stdout.write(formatMetrics(result) + '\n');
}
