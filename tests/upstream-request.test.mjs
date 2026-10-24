// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { publicRequestSource, requestDraft, requestMailto, requestText } = await import(
  moduleUrl('../web/src/upstream-request.ts')
);
const { default: UpstreamRequest } = await import(moduleUrl('../web/src/UpstreamRequest.tsx'));
const head = 'a'.repeat(40),
  id = '01234567-89ab-4def-8abc-0123456789ab';

test('public correction draft names the exact original Git revision and stays distinct from an operator receipt', () => {
  const source = publicRequestSource({
    hosted: { upstream: 'https://github.com/tests/public-example', visibility: 'public' },
    gitHead: head,
    sourceId: 'b'.repeat(64),
    privateToken: 'secret',
  });
  assert.deepEqual(source, { repository: 'https://github.com/tests/public-example', revision: head });
  const draft = requestDraft(source, id, '2026-10-03T12:00:00.000Z');
  assert.equal(draft.status, 'draft-not-submitted');
  const text = requestText(draft);
  assert.match(text, /Correlation ID: 01234567/);
  assert.match(text, new RegExp(`Indexed Git revision: ${head}`));
  assert.doesNotMatch(text, /secret|bbbbbbbb/);
  const mail = new URL(requestMailto(draft));
  assert.equal(mail.protocol, 'mailto:');
  assert.equal(mail.pathname, 'support@nanthai.tech');
  assert.equal(mail.searchParams.get('body'), text);
  assert.equal(mail.searchParams.getAll('bcc').length, 0);
  const html = renderToStaticMarkup(createElement(UpstreamRequest, { source }));
  assert.match(html, /Report an upstream issue/);
  assert.match(html, /Opening your email app does not send a message/);
  assert.match(html, /An operator acknowledgment is your receipt/);
  assert.match(html, /Save draft/);
  assert.match(html, new RegExp(head));
});

test('private/local/unknown source cannot auto-prefill a repository, revision, session URL or requester identity', () => {
  for (const status of [
    undefined,
    { gitHead: head },
    {
      hosted: { upstream: 'https://github.com/tests/private-example', visibility: 'private' },
      gitHead: head,
      accountId: 'private-user',
      url: 'http://127.0.0.1/#token=private-capability',
    },
    {
      hosted: { upstream: 'https://github.com/tests/private-example', visibility: 'unknown' },
      gitHead: head,
    },
  ]) {
    const source = publicRequestSource(status);
    assert.equal(source, undefined);
    const draft = requestDraft(source, id);
    assert.equal(draft.repository, '');
    assert.equal(draft.revision, '');
    assert.equal(draft.type, 'help');
    assert.doesNotMatch(requestMailto(draft), /private-example|private-user|private-capability|aaaaaaaa/);
  }
  const html = renderToStaticMarkup(createElement(UpstreamRequest));
  assert.match(html, /Contact Forge support/);
  assert.doesNotMatch(html, /private-example|private-capability/);
  assert.doesNotMatch(html, /required=| disabled=/);
});

test('original public identity excludes credential/query/fragment/host substitutions and never labels a branch as a commit', () => {
  for (const upstream of [
    'javascript:alert(1)',
    'https://github.com.evil/tests/example',
    'https://user:password@github.com/tests/example',
    'https://github.com:444/tests/example',
    'https://github.com/tests/example?token=secret',
    'https://github.com/tests/example#secret',
    'https://github.com/tests/example/pull/1',
  ])
    assert.equal(
      publicRequestSource({ hosted: { upstream, visibility: 'public' }, gitHead: head }),
      undefined,
    );
  assert.deepEqual(
    publicRequestSource({
      hosted: { upstream: 'https://github.com/tests/example', visibility: 'public' },
      gitHead: 'main',
    }),
    { repository: 'https://github.com/tests/example' },
  );
});

test('untrusted request text remains text in the email draft and renderer, with no automatic sending or claim authorization', () => {
  const draft = {
    ...requestDraft(undefined, id),
    type: 'claim',
    message: '<script>alert(1)</script>\n&bcc=other@example.invalid',
  };
  const mail = new URL(requestMailto(draft));
  assert.equal(mail.searchParams.get('bcc'), null);
  assert.ok(mail.searchParams.get('body').includes(draft.message));
  assert.equal(draft.status, 'draft-not-submitted');
  const html = renderToStaticMarkup(
    createElement(UpstreamRequest, {
      source: { repository: '<script>synthetic</script>', revision: '</input><script>synthetic</script>' },
    }),
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;synthetic/);
  assert.match(html, /does not change stored source or access/);
});
