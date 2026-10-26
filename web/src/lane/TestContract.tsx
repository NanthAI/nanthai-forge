// SPDX-License-Identifier: Apache-2.0
import type { IntentTestContract } from '../../../src/intent-test-contract';
import { ExactRecord, Panel } from '../ui/primitives';
import './test-contract.css';
export function TestContract({ contract }: { contract?: IntentTestContract | null | undefined }) {
  if (!contract) return null;
  return (
    <Panel
      title="Proving tests"
      count={contract.tests.length}
      actions={<span className="num">{(contract.totalMs / 1000).toFixed(2)} s</span>}
    >
      <p className="fx-panel-note">
        Measured on <code title={contract.measuredOn}>{contract.measuredOn.slice(0, 12)}</code>
      </p>
      <ul className="fx-test-contract-tests">
        {contract.tests.map(test => (
          <li key={test.path}>
            <code>{test.path}</code> · <span className="num">{(test.durationMs / 1000).toFixed(2)} s</span>
          </li>
        ))}
      </ul>
      <ExactRecord
        rows={[
          ['Measured on', contract.measuredOn],
          ['Candidate', contract.candidateId],
          ['Run', contract.runId],
          ['Contract version', String(contract.version)],
        ]}
      />
    </Panel>
  );
}
