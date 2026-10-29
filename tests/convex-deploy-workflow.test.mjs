import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/convex-deploy.yml', 'utf8');

test('dev Convex deploys only from main pushes inside the locked environment', () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /environment: convex-dev/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /CONVEX_DEPLOY_KEY: \$\{\{ secrets\.CONVEX_DEPLOY_KEY \}\}/);
  assert.equal(workflow.match(/secrets\./g).length, 1);
});
