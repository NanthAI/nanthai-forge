// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export class ShotError extends Error {}
export const usage = `Hosted Forge screenshots (outside verify).
node scripts/ui-shots.mjs --base URL --out DIR \\
  --pages 'now,intents,lane:<id>,settings,device' \\
  --widths 1500,390 --themes dark,light

Optional: --intent-layout list|board (Intents layout), --diff-file PATH (open a Lane file or a Code file), --project ID (defaults to credentials.projectId), --height 1000,
--credentials FILE (defaults to ~/.config/forge-ui-bot/credentials.json).
--pages landing captures the public page (stills per width and theme, keyboard, no-JS, a hero strip), its
motion lifecycle and cold-load cost; point --base at a built preview. No bot credentials are read.
Install Chromium once: npx playwright install chromium`;

export function options(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        base: { type: 'string' },
        out: { type: 'string' },
        project: { type: 'string' },
        'diff-file': { type: 'string' },
        'intent-layout': { type: 'string' },
        pages: { type: 'string', default: 'now,intents,settings' },
        widths: { type: 'string', default: '1500,390' },
        themes: { type: 'string', default: 'dark,light' },
        height: { type: 'string', default: '1000' },
        credentials: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch {
    throw new ShotError('Invalid arguments. Use --help.');
  }
  if (values.help) return { help: true };
  let base;
  try {
    base = new URL(values.base);
  } catch {
    throw new ShotError('--base must be a URL.');
  }
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new ShotError('--base must be an HTTP(S) URL without credentials, query or fragment.');
  if (!values.out) throw new ShotError('--out is required. Keep private screenshots outside the repo.');
  if (values['intent-layout'] && !['list', 'board'].includes(values['intent-layout']))
    throw new ShotError('--intent-layout must be list or board.');
  const pages = values.pages.split(',');
  if (
    pages.some(
      p =>
        !/^(landing|home|now|intents|lanes|planning|stats|code|settings(?::(?:checks|access|devices|github))?|device|(?:lane|initiative):[A-Za-z0-9_-]+)$/.test(
          p,
        ),
    )
  )
    throw new ShotError(
      'Unknown page. Use landing,home,now,intents,lanes,planning,stats,code,lane:<id>,initiative:<id>,settings[:checks|access|devices|github],device.',
    );
  if (pages.includes('landing') && pages.length !== 1)
    throw new ShotError('Capture landing separately from signed-in pages.');
  const widths = values.widths.split(',').map(Number),
    height = Number(values.height);
  if ([...widths, height].some(n => !Number.isSafeInteger(n) || n <= 0))
    throw new ShotError('Widths and height must be positive integer pixels.');
  const themes = values.themes.split(',');
  if (themes.some(t => !['dark', 'light'].includes(t))) throw new ShotError('Themes must be dark or light.');
  return {
    base: base.href,
    out: resolve(values.out),
    project: values.project,
    diffFile: values['diff-file'],
    intentLayout: values['intent-layout'],
    pages,
    widths,
    height,
    themes,
    credentials: values.credentials
      ? resolve(values.credentials)
      : join(homedir(), '.config/forge-ui-bot/credentials.json'),
  };
}
