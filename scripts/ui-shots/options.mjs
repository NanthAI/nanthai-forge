// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export class ShotError extends Error {}
export const usage = `Hosted Forge screenshots (outside verify).
node scripts/ui-shots.mjs --base URL --out DIR \\
  --pages 'now,intents,lane:<id>,review:<id>,settings,device' \\
  --widths 1500,390 --themes dark,light

Optional: --intent-layout list|board (Intents layout), --diff-file PATH (select a Lane/Review diff), --project ID (defaults to credentials.projectId), --height 1000,
--credentials FILE (defaults to ~/.config/forge-ui-bot/credentials.json).
--pages landing captures the signed-out front door, a four-frame hero strip,
and a 30-second animated/still CPU comparison; no bot credentials are read.
--pages bootstrap captures synthetic New project and empty-project components,
including a lost-response retry, without credentials or hosted writes.
Lane/View variants: --variants unified,split,inline,side-closed,files-closed,map
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
        variants: { type: 'string', default: 'unified' },
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
        !/^(bootstrap|landing|home|now|intents|lanes|planning|activity|code|code-graph|settings(?::(?:general|agents|autonomy|checks|access|backups|appearance|devices|contributions|transfer|github))?|device|(?:lane|review|intent|view|initiative):[A-Za-z0-9_-]+)$/.test(
          p,
        ),
    )
  )
    throw new ShotError('Unknown page. Use landing,now,intents,lanes,lane:<id>,review:<id>,settings,device.');
  if (pages.includes('bootstrap') && pages.length !== 1)
    throw new ShotError('Capture synthetic bootstrap separately from signed-in pages.');
  if (pages.includes('landing') && pages.length !== 1)
    throw new ShotError('Capture landing separately from signed-in pages.');
  const widths = values.widths.split(',').map(Number),
    height = Number(values.height);
  if ([...widths, height].some(n => !Number.isSafeInteger(n) || n <= 0))
    throw new ShotError('Widths and height must be positive integer pixels.');
  const themes = values.themes.split(',');
  if (themes.some(t => !['dark', 'light'].includes(t))) throw new ShotError('Themes must be dark or light.');
  const variants = values.variants.split(',');
  if (
    variants.some(
      variant => !['unified', 'split', 'inline', 'side-closed', 'files-closed', 'map'].includes(variant),
    )
  )
    throw new ShotError('Unknown Lane variant. Use unified,split,inline,side-closed,files-closed,map.');
  return {
    variants,
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

export function destination(base, project, page, intentId) {
  const url = new URL(base);
  if (page === 'landing') return url.href;
  if (page === 'home') {
    url.searchParams.set('surface', 'projects');
    return url.href;
  }
  if (page === 'device') return new URL('/device', base).href;
  url.search = '';
  url.searchParams.set('surface', 'projects');
  url.searchParams.set('project', project);
  const [kind, id] = page.split(':');
  url.searchParams.set(
    'projectTab',
    {
      now: 'overview',
      intents: 'intent',
      lanes: 'lanes',
      planning: 'planning',
      initiative: 'planning',
      activity: 'coordination',
      code: 'delivery',
      'code-graph': 'delivery',
      settings: 'sharing',
      lane: 'lanes',
      review: 'intent',
      intent: 'intent',
      view: 'views',
    }[kind],
  );
  if (kind === 'code-graph') url.searchParams.set('codeView', 'graph');
  if (kind === 'settings' && id) url.searchParams.set('settingsSection', id);
  if (kind === 'initiative') {
    url.searchParams.set('planningItem', id);
    url.searchParams.set('planningRoute', `initiative:${id}`);
  }
  if (kind === 'intent') url.searchParams.set('intent', id);
  if (kind === 'view') url.searchParams.set('viewId', id);
  if (kind === 'lane') url.searchParams.set('lane', id);
  if (kind === 'review') {
    if (!intentId) throw new ShotError('The requested View has no parent Intent.');
    url.searchParams.set('classic', '1');
    url.searchParams.set('intent', intentId);
    url.searchParams.set('intentTab', 'delivery');
    url.searchParams.set('reviewView', id);
  }
  return url.href;
}

/** Accept only the selected project's lossless View URL after the app canonicalizes legacy links. */
export function selectedReviewRoute(actual, requested, projectId, viewId) {
  const a = new URL(actual),
    b = new URL(requested);
  const short = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(viewId)
    ? `v-${Buffer.from(viewId.replaceAll('-', ''), 'hex').toString('base64url')}`
    : viewId;
  const parts = a.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return (
    a.origin === b.origin &&
    parts.length === 4 &&
    parts[1].endsWith(`~${projectId}`) &&
    parts[2] === 'review' &&
    parts[3] === short
  );
}
