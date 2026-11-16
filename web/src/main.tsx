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
import { isAppPath } from './app/paths';
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
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
const root = createRoot(document.getElementById('root')!);
// The rebuilt app (Item 84125787) serves every address under /-; everything else is the old app until stage C.
if (isAppPath(location.pathname)) {
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
    .then(({ default: Hosted }) => root.render(frame(<Hosted />)))
    .catch(() =>
      root.render(frame(<ErrorToast error="Could not load Forge." retry={() => location.reload()} />)),
    );
}
