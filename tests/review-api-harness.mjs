// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Shared fakes for the review script tests (Items f082efd6, 3bd3eb0f): every edge injected, no network.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realDeps } from '../scripts/review-api.mjs';

export const SECRET = `fake-key-${'cd'.repeat(12)}`; // low entropy on purpose: the secret scanner must not flag a fixture
export const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+y\n';

export const finding = (severity, line, title, extra = {}) => ({
  severity,
  file: 'src/a.ts',
  line,
  title,
  detail: `${title} detail`,
  failure_scenario: 'f',
  ...extra,
});
export const anthropicOf = (payload, usage = { input_tokens: 1000, output_tokens: 500 }) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  stop_reason: 'end_turn',
  usage,
});
export const openaiOf = (payload, usage = { input_tokens: 3000, output_tokens: 500 }) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
  usage,
});

/** `replies` maps a URL fragment ('openai' | 'anthropic') to a reply object, or to a function giving the response. */
export function harness({ replies = {}, deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-api-'));
  writeFileSync(
    join(dir, 'AGENTS.md'),
    '- Never print environment values or secrets, or read credential files raw.\n',
  );
  const sent = [];
  const out = [];
  const h = {
    dir,
    sent,
    out,
    deps: {
      ...realDeps,
      spendLog: join(dir, 'log', 'spend.jsonl'),
      now: () => new Date('2026-11-23T12:00:00Z'),
      out: text => out.push(text),
      readText: (root, rel) => (rel === 'src/a.ts' ? 'x\ny\n' : realDeps.readText(root, rel)),
      async nforge(_lane, action) {
        if (action === 'diff')
          return {
            sourceContext: { laneId: 'lane-1' },
            result: { diff: DIFF, nextCursor: null, omitted: [] },
          };
        return {
          result: {
            item: { title: 'T', body: 'review-tier: core\nDone when:\n- [ ] it works' },
            comments: [],
          },
        };
      },
      localConfig: () => ({}),
      readKey: () => SECRET,
      backoff: async () => {},
      async request(url, init) {
        sent.push({ url, init });
        const reply = replies[url.includes('openai') ? 'openai' : 'anthropic'];
        if (typeof reply === 'function') return reply();
        return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
      },
      ...deps,
    },
  };
  h.rows = () =>
    readFileSync(h.deps.spendLog, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter(r => r.kind === 'call');
  return h;
}
