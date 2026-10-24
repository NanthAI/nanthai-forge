// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { SecretRevokeContents } = await import(moduleUrl('../web/src/SecretRevokeConfirmation.tsx'));
const render = extra =>
  renderToStaticMarkup(
    createElement(SecretRevokeContents, {
      principal: 'B',
      busy: false,
      close() {},
      confirm: async () => {},
      names: { B: 'Blair', C: '<script>untrusted</script>' },
      titleId: 'revoke-title',
      preview: { policyRevision: 4, grants: [{ principal: 'C', capabilities: ['use'], expiresAt: null }] },
      ...extra,
    }),
  );
test('revocation confirmation names the delegate, counts and lists affected recipients and escapes provider names', () => {
  const html = render();
  assert.match(html, /Revoke access for Blair\?/);
  assert.match(html, /This also removes 1 grants made by Blair/);
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt; · use/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, />Revoke access<\/button>/);
  assert.doesNotMatch(html, /disabled/);
});
test('confirmation waits for the actual preview, supports empty cascades and keeps IDs when display names are unavailable', () => {
  const loading = render({ preview: undefined });
  assert.match(loading, /Loading affected grants/);
  assert.match(loading, /disabled="">Revoke access/);
  assert.doesNotMatch(loading, /This also removes/);
  const empty = render({ names: {}, preview: { policyRevision: 5, grants: [] } });
  assert.match(empty, /Revoke access for B\?/);
  assert.match(empty, /This also removes 0 grants made by B/);
  assert.match(render({ busy: true }), /disabled="">Revoking…/);
});
