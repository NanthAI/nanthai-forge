// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { moduleUrl } from './convex-module.mjs';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const { localAgentPrompt } = await import(moduleUrl('../web/src/local-agent-prompt.ts'));
const retiredCommand = /nforge\s+work\b|\b(?:restore-native|restore-work|export-work|define-check)\b/;

test('copyable web commands cannot recommend the retired native CLI (journey defect 7)', () => {
  // Also catch the old JSX branch that assembled the command from sourceKind.
  assert(retiredCommand.test("nforge {sourceKind === 'native' ? 'restore-native' : 'restore-work'} ARCHIVE"));
  function scan(url) {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry.name))
        assert.equal(retiredCommand.test(readFileSync(path, 'utf8')), false, path.pathname);
    }
  }
  scan(new URL('../web/src/', import.meta.url));
});

test('agent handoffs use hosted clones for both retained archive and object projects', () => {
  for (const objects of [false, true]) {
    const prompt = localAgentPrompt({
      name: 'Synthetic',
      projectId: 'project',
      backend: 'https://fixture.invalid',
      source: 'main',
      revision: 1,
      objects,
    });
    assert.doesNotMatch(prompt, retiredCommand);
    assert.match(prompt, /nforge clone/);
    assert.match(prompt, /nforge agent ROOT land --save/);
    assert.doesNotMatch(prompt, /return.*exchange\/proposal/i);
  }
});

test('top-level help separates hosted landing queue from local command recovery', () => {
  const help = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
  assert.doesNotMatch(help, /offline Git adoption/);
  assert.match(help, /nforge agent ROOT queue/);
  assert.match(help, /nforge queue[^\n]*# local command recovery/);
  assert.doesNotMatch(help, retiredCommand);
});

test('the empty-project import opens supported project creation instead of an archive route', () => {
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('../web/src/NewHostedProject.tsx', import.meta.url), 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
    {
      exports: module.exports,
      require: name => (name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : {}),
    },
  );
  let imported = false;
  const tree = module.exports.HostedProjectWelcome({
    addAgent() {},
    importSource() {
      imported = true;
    },
    dismiss() {},
  });
  const nodes = value =>
    Array.isArray(value)
      ? value.flatMap(nodes)
      : value && typeof value === 'object'
        ? [value, ...nodes(value.props?.children)]
        : [];
  const button = nodes(tree).find(
    node => node.type === 'button' && node.props.children === 'Import from GitHub',
  );
  assert(button, 'offer the supported GitHub import');
  button.props.onClick();
  assert(imported);
});

test('the check command shown to owners satisfies the hosted configure-check schema', () => {
  const source = readFileSync(new URL('../web/src/settings/HostedChecks.tsx', import.meta.url), 'utf8');
  const command = source.match(/command=\{`([^`]+)`\}/)?.[1];
  assert(command, 'copyable command exists');
  assert.match(command, /^nforge x \S+ configure-check /);
  const json = command.slice(command.indexOf("'{") + 1, -1);
  assert(hostedAgentCommandSchemas['configure-check'].safeParse(JSON.parse(json)).success);
});

test('the welcome import callback leaves the project and opens the project creation dialog', () => {
  const source = readFileSync(new URL('../web/src/ProjectBackups.tsx', import.meta.url), 'utf8');
  const callback = source.match(/importSource=\{(\(\) => \{[\s\S]*?\})\}/)?.[1];
  assert(callback);
  const state = { project: 'empty-project', welcome: 'empty-project', dialog: false };
  runInNewContext(`(${callback})()`, {
    setCreatedProject(value) {
      state.welcome = value;
    },
    chooseProject(value) {
      state.project = value;
    },
    showNewProject(value) {
      state.dialog = value;
    },
  });
  assert.deepEqual(state, { project: '', welcome: null, dialog: true });
});

function uiModule(path, imports, exposeHistory = false) {
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  let source = readFileSync(new URL(`../web/src/${path}`, import.meta.url), 'utf8');
  if (exposeHistory) source = source.replace('function History(', 'export function History(');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, [], `${path} parses`);
  const code = compiled.outputText;
  runInNewContext(code, {
    exports: module.exports,
    require: name => (name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : (imports[name] ?? {})),
  });
  return module.exports;
}
const uiNodes = value =>
  Array.isArray(value)
    ? value.flatMap(uiNodes)
    : value && typeof value === 'object'
      ? [value, ...uiNodes(value.props?.children)]
      : [];
const uiText = value =>
  Array.isArray(value)
    ? value.map(uiText).join('')
    : value && typeof value === 'object'
      ? uiText(value.props?.children)
      : String(value ?? '');

test('every stored checkpoint offers recovery guidance while preserving its download', () => {
  for (const transport of [undefined, 'objects']) {
    const backup = {
      id: 'backup',
      status: 'stored',
      transport,
      at: 1,
      size: 1,
      preview: { channels: [], revision: 1 },
    };
    const { History } = uiModule(
      'ProjectBackups.tsx',
      {
        'convex/react': { usePaginatedQuery: () => ({ results: [backup], status: 'Exhausted' }) },
        '../../convex/_generated/api': { api: { projectBackups: { history: 'history' } } },
        './ui/count': { countLabel: () => '' },
        './ExchangeHandoff': { default: 'RecoveryGuide' },
      },
      true,
    );
    const tree = History({ projectId: 'project', operate() {}, busy: false, readOnly: false });
    assert(
      uiNodes(tree).some(node => node.type === 'RecoveryGuide'),
      'archives and objects have a usable recovery request',
    );
    assert(uiText(tree).includes('Download source and Work'));
  }
});

test('proposal provenance recommends receive only for supported stored object proposals', () => {
  const { ProposalProvenance } = uiModule('ProjectProposals.tsx', {
    './DetailPanel': { DetailPanel: 'aside' },
  });
  for (const transport of [undefined, 'objects']) {
    const proposal = {
      transport,
      status: 'stored',
      actor: 'contributor',
      baseState: 'base',
      head: 'head',
      viewId: 'candidate',
      digest: 'digest',
    };
    const text = uiText(ProposalProvenance({ proposal, projectKey: 'synthetic' }));
    assert.equal(text.includes('receive-proposal'), transport === 'objects');
    if (!transport) assert(text.includes('Download proposal'));
  }
});

// J16-2: no current CLI can create the native archive this form once required.
test('new proposals use hosted Lanes while existing archive recovery and downloads remain', () => {
  const text = readFileSync(new URL('../web/src/ProjectProposals.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /Send changes from your computer|Send proposal|<form/);
  assert.match(text, /hosted clone and start a Lane/);
  assert.match(text, /Original archive for a pending upload/);
  assert.match(text, /Download proposal/);
  assert.match(text, /Reconcile original upload/);
});
