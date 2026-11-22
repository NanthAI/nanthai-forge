// SPDX-License-Identifier: Apache-2.0
// An Item's discussion (Item 9a3d6f5f): member Markdown is drawn without running raw HTML or unsafe links, threads keep
// replies under their root, the count reconciles with what is shown, and writers show by public identity only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { Discussion } = await import(moduleUrl('../web/src/app/discussion/Discussion.tsx'));
const model = await import(moduleUrl('../web/src/app/discussion/model.ts'));
const { safeHref } = await import(moduleUrl('../web/src/ds/markdown.tsx'));

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const comment = (n, extra = {}) => ({
  id: id(n),
  itemId: id(0),
  text: `Comment ${n}`,
  at: `2026-11-1${n % 10}T09:00:00.000Z`,
  ...extra,
});
const render = props =>
  renderToStaticMarkup(
    h(Discussion, {
      canWrite: true,
      onPost: async () => {},
      now: new Date('2026-11-17T12:00:00Z'),
      ...props,
    }),
  );

test('hostile comment text renders as inert text: no raw HTML, scripts, handlers or javascript: links', () => {
  const html = render({
    comments: [
      comment(1, {
        text: '<script>alert(1)</script>\n\nSay **bold** <img src=x onerror=alert(2)> [x](javascript:alert(3)) [y](data:text/html,hi) ![i](https://example.com/a.png) <a href="https://evil.example">raw</a>\n\n# Heading\n\n- list\n\n`code`',
      }),
    ],
  });
  assert.doesNotMatch(html, /<script|alert\(1\)/i, 'an HTML block is dropped whole');
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:text/i);
  assert.doesNotMatch(html, /<img/i, 'outside images are not loaded');
  assert.doesNotMatch(html, /evil\.example/, 'raw HTML anchors are dropped');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<h3>Heading<\/h3>/, 'member headings sit under the screen headings');
  assert.match(html, /<li>list<\/li>/);
  assert.match(html, /<code>code<\/code>/);
});

test('the security review hostile inputs stay inert: obfuscated schemes, raw HTML of every kind, images in links', () => {
  const hostile = [
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<style>body{display:none}</style>',
    '<!-- secret-note -->',
    '[a](JaVaScRiPt:alert(1)) [b](java&#x73;cript:alert(1)) [c](java\tscript:alert(1))',
    '[d](vbscript:msgbox) [e](file:///etc/passwd) [f](//evil.example) [g](\\\\evil.example) [h](/x)',
    '[ref][r]\n\n[r]: javascript:alert(4)',
    '<javascript:alert(5)>',
    '[![i](https://evil.example/p.png)](https://example.com)',
    '```js" onmouseover="alert(6)\ncode\n```',
    'Note[^x" onclick="alert(7)].\n\n[^x" onclick="alert(7)]: foot',
  ].join('\n\n');
  const html = render({ comments: [comment(1, { text: hostile })] });
  for (const bad of [/<svg/i, /<iframe/i, /<style/i, /secret-note/, /<img/i, /<[^>]*\son[a-z]+=/i])
    assert.doesNotMatch(html, bad);
  for (const href of html.matchAll(/href="([^"]*)"/g))
    assert.match(href[1], /^(https?:\/\/|mailto:|#)/, `only safe links: ${href[1]}`);
  assert.doesNotMatch(html, /evil\.example"/, 'no link or image leads to the outside host');
});

test('outside links name their host on hover, and footnote ids are kept apart per comment', () => {
  const html = render({
    comments: [
      comment(1, { text: '[docs](https://docs.example.com/a?b=c) and a note[^1].\n\n[^1]: First.' }),
      comment(2, { text: 'Another note[^1].\n\n[^1]: Second.' }),
    ],
  });
  assert.match(html, /title="Opens docs\.example\.com"/);
  const ids = [...html.matchAll(/ id="(user-content-[^"]+)"/g)].map(match => match[1]);
  assert.ok(ids.length >= 4, 'each comment has its footnote and back reference');
  assert.equal(new Set(ids).size, ids.length, 'no footnote id repeats on the page');
  assert.ok(ids.some(entry => entry.startsWith(`user-content-${id(1)}-`)));
});

test('only http(s), mailto and in-page anchors become links, and outside links open safely', () => {
  assert.deepEqual(safeHref('https://example.com/a'), { href: 'https://example.com/a', external: true });
  assert.deepEqual(safeHref('#comment-1'), { href: '#comment-1', external: false });
  for (const bad of [
    'javascript:alert(1)',
    ' JavaScript:x',
    'data:text/html,x',
    '//evil.example',
    '/x',
    'vbscript:x',
  ])
    assert.equal(safeHref(bad), null, bad);
  const html = render({ comments: [comment(1, { text: '[docs](https://example.com/docs)' })] });
  assert.match(html, /rel="noreferrer noopener nofollow ugc"/);
  assert.match(html, /target="_blank"/);
});

test('replies sit under their thread root, and the count reconciles with the threads shown', () => {
  const comments = [comment(1), comment(2, { replyTo: id(1) }), comment(3), comment(4, { replyTo: id(1) })];
  const threads = model.threads(comments);
  assert.deepEqual(
    threads.map(thread => [thread.root.id, thread.replies.map(reply => reply.id)]),
    [
      [id(1), [id(2), id(4)]],
      [id(3), []],
    ],
  );
  const html = render({ comments, pageSize: 1 });
  assert.match(html, /Showing the latest 1 of 2 threads\./);
  assert.match(html, /Show 1 earlier/);
  assert.match(html, />2 threads</);
});

test('writers show who wrote it: person or agent run with its declared model, never "A member" (Item 2fb69177)', () => {
  const person = { kind: 'person', model: null, verified: true };
  // Owner and members: the server maps the account to the handle.
  assert.deepEqual(model.writer(comment(1, { author: 'mara' })), { ...person, label: '@mara' });
  assert.deepEqual(
    model.writer(
      comment(1, { author: 'mara', agent: 'keen-impala', agentClient: 'claude-code:claude-opus-5-5' }),
    ),
    { kind: 'agent', label: 'mara/keen-impala', model: 'claude-opus-5-5', verified: true },
  );
  assert.deepEqual(model.writer(comment(1, { author: 'mara', agent: 'keen-impala', agentClient: 'codex' })), {
    kind: 'agent',
    label: 'mara/keen-impala',
    model: null,
    verified: true,
  });
  // Readers and public viewers: the server leaves the account out; the kind and the run name stay.
  assert.deepEqual(model.writer(comment(1, { agent: 'keen-impala' })), {
    kind: 'agent',
    label: 'keen-impala',
    model: null,
    verified: true,
  });
  assert.deepEqual(model.writer(comment(1, {})), { kind: 'person', label: '', model: null, verified: false });
  // A Forge job and an older typed label.
  assert.equal(model.writer(comment(1, { author: 'forge:expiry' })).kind, 'forge');
  assert.deepEqual(model.writer(comment(1, { authorLabel: '@lead-sweep' })), {
    kind: 'person',
    label: 'lead-sweep',
    model: null,
    verified: false,
  });
  assert.equal(model.writer(comment(1, { authorLabel: 'Ada Lovelace' })).label, '');
  assert.equal(model.writer(comment(1, { authorLabel: 'adas-macbook.local' })).label, '');
  const html = render({
    comments: [
      comment(1, { authorLabel: 'Ada Lovelace' }),
      comment(2, { author: 'mara', agent: 'keen-impala', agentClient: 'claude-code:claude-opus-5-5' }),
      comment(3, { authorLabel: '@sample-forged' }),
      comment(4, { author: 'jun', agent: 'copper-moth' }),
      comment(5, { author: 'orla' }),
      comment(6, { agent: 'amber-fox' }),
    ],
  });
  assert.doesNotMatch(html, /Ada/);
  assert.doesNotMatch(html, /A member/);
  assert.match(html, /class="who" data-kind="agent" title="mara\/keen-impala · claude-opus-5-5"/);
  assert.match(html, /class="who" data-kind="agent" title="jun\/copper-moth · model not declared"/);
  assert.match(html, /class="who" data-kind="person" title="@orla"/);
  assert.match(html, /data-kind="agent"[^>]*>[\s\S]*?class="av ag"/, 'an agent run gets the outlined mark');
  assert.match(
    html,
    /class="a-run mono"[^>]*>amber-fox<\/span>/,
    'a hidden person still shows the agent run',
  );
  assert.doesNotMatch(html, /@sample-forged/, 'a typed label never gets the handle mark');
  assert.match(html, /sample-forged<\/span><span class="t3"[^>]*>not verified/);
});

test('decisions are marked, reactions show counts and the viewer’s own, readers get no composer', () => {
  const comments = [comment(1, { decision: true, author: 'mara' })];
  const reactions = [{ commentId: id(1), kind: '+1', count: 3, mine: true }];
  const html = render({ comments, reactions, onReact: async () => {} });
  assert.match(html, />Decision</);
  assert.match(html, /aria-pressed="true"[^>]*aria-label="thumbs up: 3, yours"/);
  assert.match(html, /This is a decision: keep it in the body/);
  const reader = render({ comments, reactions, canWrite: false });
  assert.doesNotMatch(reader, /<textarea/);
  assert.doesNotMatch(reader, />Reply</);
  assert.match(reader, /disabled=""/);
});

test('Lane and Item threads pin an open ask ahead of history and retain the answer and resume prompt', () => {
  const ask = {
    id: id(30),
    at: Date.parse('2026-11-05'),
    actor: 'sample-one',
    agent: 'amber-fox',
    type: 'question',
    text: 'Which endpoint should the Lane use?',
    choices: ['Use v1', 'Use v2'],
    mayAnswer: true,
  };
  const note = {
    id: id(31),
    at: Date.parse('2026-11-12'),
    actor: 'sample-one',
    type: 'note',
    text: 'Board note',
  };
  const answer = async () => {};
  const open = render({
    title: 'Thread',
    comments: [],
    conversation: { entries: [note, ask], loading: false, answer },
  });
  assert.match(open, /data-pinned/);
  assert(open.indexOf(ask.text) < open.indexOf(note.text));
  assert.match(open, /<button[^>]*><span dir="auto">Use v1<\/span><\/button>/);
  assert.match(open, /<button[^>]*><span dir="auto">Use v2<\/span><\/button>/);
  const recorded = render({
    comments: [comment(4, { text: 'Item comment' })],
    conversation: {
      entries: [
        note,
        {
          ...ask,
          answer: { choice: 'Use v2', text: 'Both clients use it.', resumePrompt: 'Resume this Lane.' },
        },
      ],
      loading: false,
      answer,
    },
  });
  assert.doesNotMatch(recorded, /data-pinned|<button[^>]*><span dir="auto">Use v1<\/span><\/button>/);
  assert(recorded.indexOf(ask.text) < recorded.indexOf('Both clients use it.'));
  assert(recorded.indexOf(note.text) < recorded.indexOf('Item comment'));
  assert.match(recorded, /Give this to your agent/);
  assert.match(recorded, /Resume this Lane\./);
});

test('a hand-back in the thread keeps the saved pin and explains who carries it', () => {
  const html = render({
    title: 'Thread',
    comments: [],
    conversation: {
      entries: [
        {
          id: id(40),
          at: Date.parse('2026-11-18'),
          type: 'hand-back',
          actor: 'sample-one',
          text: 'Tried old client',
          left: 'Check user decision',
          head: 'b'.repeat(64),
          to: 'sample-two',
          mayAnswer: true,
        },
      ],
      loading: false,
      answer: async () => {},
    },
  });
  for (const value of ['Tried old client', 'Check user decision', 'b'.repeat(64), 'sample-two', 'Decline'])
    assert(html.includes(value));
});
