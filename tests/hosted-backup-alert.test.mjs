// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { main } from '../scripts/hosted-backup-alert.mjs';

const sentinel = 'SYNTHETIC_PRIVATE_SECRET';
const env = {
  GITHUB_REPOSITORY: 'synthetic/forge',
  GITHUB_RUN_ID: '1234',
  FORGE_ALERT_WEBHOOK_URL: `https://synthetic.invalid/${sentinel}`,
  FORGE_ALERT_EMAIL_TOKEN: sentinel,
  FORGE_ALERT_EMAIL_ACCOUNT_ID: 'a'.repeat(32),
  FORGE_ALERT_EMAIL_TO: 'owner@example.invalid',
};
function capture(t) {
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  t.mock.method(console, 'error', line => output.push(line));
  return output;
}
test('backup failure reaches a synthetic HTTP endpoint using the existing ntfy and Cloudflare requests', async t => {
  const output = capture(t),
    received = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body });
    res.writeHead(202);
    res.end('accepted');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const send = async (url, init) => {
    assert(url.startsWith('https://api.cloudflare.com/') || url === env.FORGE_ALERT_WEBHOOK_URL);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/fake-alert`, init);
    await response.text();
    return response;
  };
  assert.equal(await main(env, send), 0);
  assert.equal(received.length, 2);
  const email = JSON.parse(received[0].body);
  assert.equal(email.from, 'support@nanthai.tech');
  assert.equal(email.to, 'owner@example.invalid');
  assert.equal(received[0].headers.authorization, `Bearer ${sentinel}`);
  const ntfy = received[1];
  assert.equal(ntfy.headers.priority, 'high');
  assert.equal(ntfy.headers.title, '[Forge] Weekly hosted backup failed');
  assert.match(ntfy.body, /https:\/\/github.com\/synthetic\/forge\/actions\/runs\/1234/);
  assert(!ntfy.body.includes(sentinel));
  assert(!output.join('').includes(sentinel));
  assert.equal(JSON.parse(output[0]).delivered, true);
});
test('absent config, provider rejection and thrown errors never silently count as delivered or leak secrets', async t => {
  const output = capture(t);
  assert.equal(await main({}, () => assert.fail('no configured endpoint')), 1);
  assert.equal(JSON.parse(output.at(-1)).error.code, 'BACKUP_ALERT_NOT_CONFIGURED');
  assert.equal(await main(env, async () => new Response(sentinel, { status: 403 })), 1);
  assert.equal(
    await main(env, async () => {
      throw new Error(sentinel);
    }),
    1,
  );
  assert(!output.join('').includes(sentinel));
});
test('one delivered channel succeeds even if the other channel fails', async t => {
  capture(t);
  assert.equal(
    await main(env, async url => new Response(null, { status: url.includes('cloudflare') ? 403 : 200 })),
    0,
  );
});
