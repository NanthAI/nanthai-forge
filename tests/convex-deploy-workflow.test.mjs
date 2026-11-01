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

// Convex imports shared reducers and transports from src; changes there must reach the server.
test('backend and shared source changes automatically deploy Convex', () => {
  for (const path of [
    'convex/**',
    'src/**',
    'package.json',
    'package-lock.json',
    '.github/workflows/convex-deploy.yml',
  ])
    assert(workflow.includes(`      - '${path}'`), `paths filter covers ${path}`);
});
