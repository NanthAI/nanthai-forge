// SPDX-License-Identifier: Apache-2.0
/** Interaction docs retries verify the whole merged View's static contracts. */
export function runDocumentationChecks({ npm, node, interaction = false }) {
  npm('run', 'check');
  if (interaction) {
    npm('run', 'typecheck');
    npm('run', 'lint');
  }
  npm('run', 'format:check');
  node('scripts/check-documents.mjs');
}
