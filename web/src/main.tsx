// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './zod-jitless';
import { ErrorToast } from './ui/Toast';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorReporter, installErrorCapture } from './error-capture';
import { AppLoader } from './ui/AppLoader';
import './ui/loader.css';
import './ui/mark.css';
import { createRoot } from 'react-dom/client';

// Shared by the loader and the app.
import './ui/tokens.css';
import './ui/components.css';
import { earlierAppPath, normalizeAccountPathname } from './app/paths';
import { oldAddress } from './app/old-address';
import { applyMotion } from './motion-pref';
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN)
      void import('./product-analytics')
        .then(({ captureBrowserAnalytics }) => captureBrowserAnalytics('screen_error'))
        .catch(() => undefined);
    const stack = error instanceof Error ? error.stack : undefined;
    errorReporter.capture('render', error, {
      ...(stack || info.componentStack
        ? {
            stack: [stack, info.componentStack && `Component stack:${info.componentStack}`]
              .filter(Boolean)
              .join('\n'),
          }
        : {}),
    });
  }
  render() {
    return this.state.failed ? (
      <ErrorToast error="Could not load this page." retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
installErrorCapture();
applyMotion();
const root = createRoot(document.getElementById('root')!);
// The CDN can serve the shell after normalizing the origin request while the browser keeps the original path.
const pathname = normalizeAccountPathname(location.pathname);
if (pathname !== location.pathname)
  history.replaceState(history.state, '', pathname + location.search + location.hash);
// The app is served at the root (Item b0704959). An address from before the switch (/-/…) is redirected by
// the site Worker (site/public-read.ts); a server that does not apply it reaches the same address here. An old address the app has a place
// for goes there: a plain path with no read (old-address.ts), an id-only link through the app, which resolves it with
// one access-checked read (OldAddress.tsx).
const earlier = earlierAppPath(pathname);
const old = earlier ? null : oldAddress(pathname, location.search);
if (earlier) {
  location.replace(earlier + location.search + location.hash);
} else if (old?.kind === 'go') {
  location.replace(old.to + (old.to.includes('#') ? '' : location.hash));
} else {
  root.render(
    <AppBoundary>
      <AppLoader />
    </AppBoundary>,
  );
  void import('./app/App')
    .then(({ default: App }) =>
      root.render(
        <AppBoundary>
          <App />
        </AppBoundary>,
      ),
    )
    .catch(() => root.render(<ErrorToast error="Could not load Forge." retry={() => location.reload()} />));
}
