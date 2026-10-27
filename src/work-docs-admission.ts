// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Classify immutable bytes with the installed selector, never execute candidate code.
 * Missing selector/inputs conservatively retain ordinary machine admission. */
export async function lightweightDocsRun(store: WorkStore, run: CheckRun): Promise<boolean> {
  if (
    !store.native ||
    run.checkSelection?.scope === 'partial' ||
    !run.interaction?.eligible ||
    run.interaction.basis !== 'docs-overlap' ||
    run.mainCheck ||
    JSON.stringify(run.check.args) !== JSON.stringify(['scripts/forge-check.mjs'])
  )
    return false;
  try {
    const { standardSelection } = await import('../scripts/test-impact.mjs');
    const source = new NativeSource(store.root);
    const files = new Map(
      source
        .state(run.head)
        .files.filter(
          file =>
            file.path === 'package-lock.json' ||
            /^(?:src|web|convex|netlify|tests|scripts)\/.+\.(?:[cm]?js|[cm]?tsx?|css|json|svg|html)$/.test(
              file.path,
            ),
        )
        .map(file => [file.path, source.object(file.blob).toString('utf8')]),
    );
    return (
      standardSelection({
        files,
        interaction: run.interaction,
        env: run.environment.env,
      }).scope === 'docs'
    );
  } catch {
    return false;
  }
}
