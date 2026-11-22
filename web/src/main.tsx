// SPDX-License-Identifier: Apache-2.0
import './zod-jitless';
import { ErrorToast, ToastProvider } from './ui/Toast';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorReporter, installErrorCapture } from './error-capture';
import { installRoutes } from './shell/location';
import { AppLoader } from './ui/AppLoader';
import { NavigationGuard } from './ui/NavigationGuard';
import './ui/loader.css';
import './shell/mark.css';
import { createRoot } from 'react-dom/client';

// Shared by the loader and both apps; the old screens' styles load with the old app (legacy-styles.ts).
import './ui/tokens.css';
import './ui/components.css';
import { isAppPath, normalizeAccountPathname } from './app/paths';
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
// The rebuilt app (Item 84125787) serves every address under /-; everything else is the old app until stage C.
// An old address the rebuilt app has a place for goes there: a plain path with no read (old-address.ts), an id-only
// link through the app, which resolves it with one access-checked read (OldAddress.tsx).
const old = oldAddress(pathname, location.search);
if (old?.kind === 'go') {
  location.replace(old.to + location.hash);
} else if (old || isAppPath(pathname)) {
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
} else {
  installRoutes(true);
  startOldApp();
}
function startOldApp() {
  const frame = (app: React.ReactNode) => (
    <ToastProvider>
      <NavigationGuard />
      <AppBoundary>{app}</AppBoundary>
    </ToastProvider>
  );
  root.render(frame(<AppLoader />));
  void import('./Hosted')
    .then(({ default: Hosted }) => {
      root.render(frame(<Hosted />));
      if (import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN)
        void import('./product-analytics')
          .then(({ captureBrowserAnalytics }) => captureBrowserAnalytics('screen_opened'))
          .catch(() => undefined);
    })
    .catch(() =>
      root.render(frame(<ErrorToast error="Could not load Forge." retry={() => location.reload()} />)),
    );
}
