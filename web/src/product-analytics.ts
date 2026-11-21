// SPDX-License-Identifier: Apache-2.0
import { analyticsTarget, sendAnalytics, type AnalyticsEvent } from '../../src/product-analytics';
import { parseAppPath, type AppRoute } from './app/paths';

function screenName(route: AppRoute) {
  switch (route.frame) {
    case 'project':
      if (route.place === 'lanes' && route.rest.endsWith('/check')) return 'lane-check';
      return route.place;
    case 'account':
      return `account-${route.place}`;
    case 'discover':
    case 'bare':
    case 'public':
      return route.page;
    case 'missing':
      return 'missing';
  }
}

const key = 'forge-product-analytics';
type Target = NonNullable<ReturnType<typeof analyticsTarget>>;
const pending = new Map<string, AnalyticsEvent[]>();

async function flush(target: Target, install: string) {
  const batches = [...pending];
  pending.clear();
  for (const [id, events] of batches) {
    let project: string | undefined;
    if (id) {
      const deployment = new URL(import.meta.env.VITE_CONVEX_URL).origin;
      const encoder = new TextEncoder();
      const salt = await crypto.subtle.importKey(
        'raw',
        encoder.encode(target.token),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const bytes = await crypto.subtle.sign('HMAC', salt, encoder.encode(`${deployment}\n${id}`));
      project = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    for (let offset = 0; offset < events.length; offset += 20)
      await sendAnalytics(target, install, events.slice(offset, offset + 20), project);
  }
}

export function captureBrowserAnalytics(
  event: 'screen_opened' | 'screen_error',
  route?: AppRoute,
  projectId?: string,
) {
  if (
    location.hostname !== 'nanthai-forge-dev.netlify.app' ||
    navigator.doNotTrack === '1' ||
    !import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN
  )
    return;
  const target = analyticsTarget(
    import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN,
    import.meta.env.VITE_FORGE_POSTHOG_REGION,
  );
  if (!target) return;
  try {
    const screen = route
      ? screenName(route)
      : location.pathname.startsWith('/-')
        ? screenName(parseAppPath(location.pathname))
        : 'legacy';
    if (event === 'screen_opened') {
      const seen = `${key}:seen:${screen}`;
      if (sessionStorage.getItem(seen)) return;
      sessionStorage.setItem(seen, '1');
      if (Math.random() >= 0.1) return;
    }
    const stored = localStorage.getItem(key);
    const distinctId =
      stored && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(stored) ? stored : crypto.randomUUID();
    if (stored !== distinctId) localStorage.setItem(key, distinctId);
    const wasEmpty = pending.size === 0;
    const id = projectId ?? '';
    let events = pending.get(id);
    if (!events) pending.set(id, (events = []));
    events.push(event === 'screen_opened' ? { event, screen } : { event, screen, code: 'render' });
    if (wasEmpty) queueMicrotask(() => void flush(target, distinctId).catch(() => undefined));
  } catch {
    // Storage and reporting may be unavailable in the browser.
  }
}
