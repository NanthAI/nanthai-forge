// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Atomic local status publication at existing CELL events, without timers or extra probes. */
export function driverProgress(root, coordination, warn = console.error) {
  const file = join(root, 'drive-progress.json');
  let state = { status: 'running', line: 'starting', coordination };
  return (update = {}) => {
    state = { ...state, ...update, at: new Date().toISOString() };
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      // Observability must not interrupt scoring or prevent the driver's hold release.
      warn(`CELL progress snapshot unavailable (${error.code ?? 'filesystem error'})`);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {}
    }
    return state;
  };
}
