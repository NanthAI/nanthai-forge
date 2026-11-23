// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
