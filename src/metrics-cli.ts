// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { invariant } from './errors.js';
import { readMetricRecords } from './self-metrics-source.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { formatMetrics, formatMetricReport } from './self-metrics-format.js';
import { recordBillCli } from './metrics-bill-cli.js';
import { metricAddress, metricQuery } from './self-metrics-source.js';
import { nameFlakeIssues } from './self-metrics-flake-issues.js';
import { pageMetrics, METRICS_PAGE_MAX } from './self-metrics-page.js';
export async function readMetrics(
  owner: string,
  options: {
    from?: string | undefined;
    to?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  } = {},
  pointer?: Buffer | null,
) {
  const period = metricPeriod(options.from, options.to);
  return pageMetrics(
    metricsSurface(await readMetricRecords(owner, period, { pointer }), period),
    period,
    options,
  );
}
export async function metricsCli(args: string[]) {
  if (args[0] === 'record-bill') return recordBillCli(args.slice(1));
  if (!args.length || args[0] === '--help') {
    process.stdout.write(
      'nforge metrics ROOT [--from DATE] [--to DATE] [--json | --text] [--report FILE.md] [--compare FROM..TO] [--limit N] [--cursor C] [--flake-issues]\nnforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N [...]\nUTC windows are [from,to). JSON is the default for agents/non-TTY output.\n--limit N pages the report row lists (N entries per list; follow page.nextCursor with --cursor C, same window); per-day rows are omitted when paging.\n--flake-issues prints only the flaky-file list, each with its Issue.\n',
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
        '--limit',
        '--cursor',
      ].includes(flag) && !(flag in options),
      'BAD_ARGUMENT',
      'Unknown or repeated metrics option.',
    );
    if (flag === '--json' || flag === '--text' || flag === '--flake-issues') options[flag] = 'true';
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
  invariant(
    !options['--cursor'] || limit !== undefined,
    'BAD_ARGUMENT',
    '--cursor needs --limit, the same as its first page.',
  );
  invariant(
    !(options['--flake-issues'] && (limit !== undefined || options['--compare'])),
    'BAD_ARGUMENT',
    '--flake-issues prints only the flake list; do not combine it with --limit or --compare.',
  );
  const result = metricsSurface(await readMetricRecords(owner, period), period);
  // Opt-in: one planning search per listed flaky file (at most 10). Reads add no calls by default.
  if (options['--flake-issues'] && result.totals.flakes.files.length) {
    const address = metricAddress(owner).address;
    if (address) await nameFlakeIssues(metricQuery(address), result.totals.flakes.files);
  }
  const before = beforePeriod
    ? metricsSurface(await readMetricRecords(owner, beforePeriod), beforePeriod)
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
