// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

// Reviewed device permissions. Each entry names an existing owner entry point; new ones need an
// explicit classification. Read-only metadata, reversible source/Work operations, project setup,
// decisions and metrics retain device access. Existing person gates remain in their own handlers.
const allowed = {
  agentGuidance: ['setMaintainer'],
  backupTransfer: ['prepare'],
  clientErrors: ['recent'],
  projectUncheckedLandingSettings: ['teams', 'history'], // Owner-only metadata, no source authority.
  projectUncheckedLanding: ['pickPerson'], // Read-only current-writer picker; grants no authority.
  projectAutonomy: ['set'], // Existing exact-change settings approvals.
  projectBackups: ['deletionStatus'],
  projectCheckLogCleanupStore: ['archive', 'review'],
  projectContributors: ['remove', 'list', 'handles', 'pending', 'cancelInvite'],
  projectExchangeMigration: ['migrate'],
  projectGithubMirrorRead: ['read'], // Read-only mirror sentence; the owner flag only shows controls.
  projectGithubMirrorResume: ['resume'],
  projectGithubStatus: ['publish'],
  projectHostedAcceptance: ['approve'], // Existing acceptanceActor person gate.
  projectHostedApprovals: ['decide', 'observe'], // decide already requires a person.
  projectHostedBirth: ['makeEditable'],
  projectHostedLanes: ['head'], // Read-only source pins and opt-in member-only holder metadata; grants no authority.
  projectHostedDecisions: ['decide', 'setMaintainer'],
  projectHostedDormant: ['abandon'],
  projectHostedLandingPriority: ['prioritize'],
  projectHostedLanePin: ['setPin'],
  projectHostedLifecycleMerged: ['completeMerged'],
  projectHostedSeed: ['begin'],
  projectLifecycle: ['rename'],
  projectNeedsMe: ['read'], // Read-only: says whether the viewer may decide; decide keeps its own person gate.
  projectPlanSettled: ['page'], // Read-only done and dropped plan rows, one bounded page; no write.
  projectLooseEnds: ['read'], // Read-only: tells the owner the authority epoch; setting aside goes through abandon.
  projectPlanView: ['read'], // Read-only plan rows; moves and new Items go through projectWorkCommand's owner gate.
  projectProposals: ['remove'],
  publicDiscovery: ['stargazers', 'settings'], // Owner-only read-only metadata: who starred, the Lane-title opt-in.
  projectR2Backfill: ['page', 'targets'],
  projectReaders: ['list', 'shared'],
  projectSelfMetricBills: ['record', 'page'],
  projectSourceAuthority: ['transition'],
  projectWorkIndex: ['workspace', 'detail'],
  planningReactions: ['toggle'], // Reversible per-person reaction toggle, same owner gate as comments.
};
test('class guard: every public owner authority entry point has reviewed device permission or a person gate', () => {
  const unknown = [];
  const directory = new URL('../convex/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer;
        if (
          !call ||
          !ts.isCallExpression(call) ||
          !['mutation', 'query', 'action', 'receiptMutation'].includes(call.expression.getText(parsed))
        )
          continue;
        const body = call.getText(parsed);
        if (!/\b(?:ownedProject|activeOwnedProject)\(|\bproject\??\.owner\s*[!=]==/.test(body)) continue;
        const name = declaration.name.getText(parsed);
        if (!/\brequireOwnerPerson\(/.test(body) && !allowed[file.slice(0, -3)]?.includes(name))
          unknown.push(`${file}:${name}`);
      }
    }
  }
  assert.deepEqual(unknown, [], 'classify the owner action or requireOwnerPerson before adding authority');
});
