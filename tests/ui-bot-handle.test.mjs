// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { isBotHandle } from '../scripts/ui-shots/bot-credentials.mjs';

test('the bot account is recognised by its sign-in name and by the dev display handle, nothing else', () => {
  assert.equal(isBotHandle('forge-ui-bot'), true);
  assert.equal(isBotHandle('forge-ui-bot-dev'), true);
  assert.equal(isBotHandle('forge-ui-bot-dev2'), false);
  assert.equal(isBotHandle('someone'), false);
  assert.equal(isBotHandle(undefined), false);
});
