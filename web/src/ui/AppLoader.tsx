// SPDX-License-Identifier: Apache-2.0
import { useTheme } from './Theme';
import { LoadingMark } from './LoadingMark';

/** One quiet arrival for module, identity and application loading. */
export function AppLoader() {
  useTheme();
  return (
    <main className="fx fx-app-loader" role="status" aria-label="Loading Forge">
      <LoadingMark />
    </main>
  );
}
