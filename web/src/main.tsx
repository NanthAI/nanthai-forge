// SPDX-License-Identifier: Apache-2.0
import { ErrorToast, ToastProvider } from './ui/Toast';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorReporter, installErrorCapture } from './error-capture';
import { installRoutes } from './shell/location';
import { AppLoader } from './ui/AppLoader';
import { NavigationGuard } from './ui/NavigationGuard';
import './ui/loader.css';
import { createRoot } from 'react-dom/client';

import './legacy.css';
import './ui/tokens.css';
import './planning.css';
import './ui/components.css';
import './ui/signals.css';
import './shell/shell.css';
import './shell/hosted-frame.css';
import './cockpit/cockpit.css';
import './cockpit/now.css';
import './cockpit/activity.css';
import './cockpit/delegate.css';
import './lane/lane.css';
import './lane/diff.css';
import './lane/lane-fable.css';
import './intents/intents.css';
import './landing/landing.css';
import './device/device.css';
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
installRoutes(true);
installErrorCapture();
const root = createRoot(document.getElementById('root')!);
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
