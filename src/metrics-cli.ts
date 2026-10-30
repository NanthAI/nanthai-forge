// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { invariant } from './errors.js';
import { readMetricRecords } from './self-metrics-source.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { formatMetrics, formatMetricReport } from './self-metrics-format.js';
import { recordBillCli } from './metrics-bill-cli.js';
export async function readMetrics(
  owner: string,
  options: { from?: string | undefined; to?: string | undefined } = {},
  pointer?: Buffer | null,
) {
  const period = metricPeriod(options.from, options.to);
  return metricsSurface(await readMetricRecords(owner, period, { pointer }), period);
}
export async function metricsCli(args: string[]) {
  if (args[0] === 'record-bill') return recordBillCli(args.slice(1));
  if (!args.length || args[0] === '--help') {
    process.stdout.write(
      'nforge metrics ROOT [--from DATE] [--to DATE] [--json | --text] [--report FILE.md] [--compare FROM..TO]\nnforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N [...]\nUTC windows are [from,to). JSON is the default for agents/non-TTY output.\n',
    );
    return;
  }
  const [owner, ...flags] = args;
  invariant(owner && !owner.startsWith('--'), 'BAD_ARGUMENT', 'Metrics requires ROOT.');
  const options: Record<string, string> = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    invariant(
      ['--from', '--to', '--compare', '--report', '--json', '--text'].includes(flag) && !(flag in options),
      'BAD_ARGUMENT',
      'Unknown or repeated metrics option.',
    );
    if (flag === '--json' || flag === '--text') options[flag] = 'true';
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
  const result = metricsSurface(await readMetricRecords(owner, period), period);
  const before = beforePeriod
    ? metricsSurface(await readMetricRecords(owner, beforePeriod), beforePeriod)
    : undefined;
  if (options['--report'])
    writeFileSync(options['--report'], formatMetricReport(result, before), { mode: 0o600 });
  if (options['--json'] || (!options['--text'] && !process.stdout.isTTY))
    return before ? { ...result, compare: before } : result;
  process.stdout.write(formatMetrics(result) + '\n');
}
