// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
