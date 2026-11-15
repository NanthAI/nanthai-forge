// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { policyPreset } from '../dist/autonomy-policy.js';

function screen(owner = true) {
  let cursor = 0;
  const values = [],
    effects = [],
    tasks = [],
    calls = [];
  const state = {
    policy: policyPreset('supervised'),
    fail: false,
    teams: [{ id: 'teams-1', name: 'Release team' }],
  };
  const hooks = {
    useState(initial) {
      const key = cursor++;
      if (!(key in values)) values[key] = initial;
      return [
        values[key],
        next => {
          values[key] = typeof next === 'function' ? next(values[key]) : next;
        },
      ];
    },
    useRef(initial) {
      const key = cursor++;
      values[key] ??= { current: initial };
      return values[key];
    },
    useEffect(effect, deps) {
      const key = cursor++;
      if (!values[key] || deps.some((value, i) => value !== values[key][i])) {
        values[key] = deps;
        effects.push(effect);
      }
    },
  };
  const request = (name, input) => {
    calls.push({ name, input: structuredClone(input) });
    const task = Promise.resolve().then(() => {
      if (name.endsWith(':read')) return { policy: structuredClone(state.policy), teamNames: {} };
      if (name.endsWith(':teams')) return { page: state.teams, isDone: true, continueCursor: '' };
      if (name.endsWith(':pickPerson')) {
        if (input.handle === '@reader') throw new Error('Choose a person with current project write access.');
        return { handle: input.handle.replace(/^@/, '') };
      }
      if (name.endsWith(':set')) {
        if (state.fail) throw new Error('Connection lost');
        const command = JSON.parse(input.command);
        state.policy = {
          ...state.policy,
          preset: 'custom',
          acceptance: { ...state.policy.acceptance, ...command.acceptance },
        };
        return { policy: structuredClone(state.policy), rule: 'owner-person' };
      }
      throw new Error(name);
    });
    tasks.push(task);
    return task;
  };
  const client = { query: request, mutation: request };
  const module = { exports: {} };
  const source = ts.transpileModule(
    readFileSync(new URL('../web/src/settings/UncheckedLanding.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(source, {
    exports: module.exports,
    crypto: { randomUUID },
    require: name => {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime')
        return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === 'convex/react') return { useConvex: () => client };
      if (name.endsWith('_generated/api'))
        return {
          api: new Proxy(
            {},
            {
              get: (_, module) =>
                new Proxy({}, { get: (_, method) => `${String(module)}:${String(method)}` }),
            },
          ),
        };
      if (name.endsWith('/primitives')) return { Button: 'button', Panel: 'section' };
      if (name.endsWith('/Toast')) return { ErrorToast: 'alert' };
      if (name.endsWith('/snapshot')) return { hostedError: e => e.message };
      if (name.endsWith('/UncheckedLandingHistory')) return { UncheckedLandingHistory: 'history' };
      throw new Error(name);
    },
  });
  let tree;
  const render = () => {
    cursor = 0;
    tree = module.exports.UncheckedLanding({ projectId: 'project', owner });
    while (effects.length) effects.shift()();
    return tree;
  };
  const nodes = node =>
    Array.isArray(node)
      ? node.flatMap(nodes)
      : node && typeof node === 'object'
        ? [node, ...nodes(node.props?.children)]
        : [];
  const text = node =>
    Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object'
        ? text(node.props?.children)
        : typeof node === 'string'
          ? node
          : '';
  const find = predicate => {
    const node = nodes(tree).find(predicate);
    assert(node, 'control exists');
    return node;
  };
  const button = label => find(node => node.type === 'button' && text(node) === label);
  const settle = async () => {
    while (tasks.length) await Promise.allSettled(tasks.splice(0));
    await Promise.resolve();
    render();
  };
  const click = async label => {
    button(label).props.onClick();
    await settle();
  };
  const choose = mode => {
    find(node => node.props?.type === 'radio' && node.props.value === mode).props.onChange();
    render();
  };
  const person = value => {
    find(node => node.props?.['aria-label'] === 'Forge handle').props.onChange({ target: { value } });
    render();
  };
  return {
    state,
    calls,
    render,
    settle,
    nodes: () => nodes(tree),
    find,
    button,
    click,
    choose,
    person,
    text: () => text(tree),
  };
}

test('web settings offer the three approved options, default to owner, and make no idle requests', async () => {
  const h = screen();
  h.render();
  await h.settle();
  const radios = h.nodes().filter(node => node.props?.type === 'radio');
  assert.deepEqual(
    radios.map(node => node.props.value),
    ['owner', 'selected', 'writers'],
  );
  assert.equal(radios.find(node => node.props.checked).props.value, 'owner');
  const calls = h.calls.length;
  h.render();
  h.render();
  await h.settle();
  assert.equal(h.calls.length, calls, 'rerenders schedule no requests');
});
test('web picker refuses read-only people and retains a selected writer in the saved policy', async () => {
  const h = screen();
  h.render();
  await h.settle();
  h.choose('selected');
  h.person('@reader');
  await h.click('Add person');
  assert.match(h.text(), /current project write access/);
  assert.equal(h.state.policy.acceptance.withoutCheck, undefined);
  h.person('@release-person');
  await h.click('Add person');
  await h.click('Save landing policy');
  assert.deepEqual(h.state.policy.acceptance.withoutCheck.people, ['release-person']);
});
test('web team picker uses existing team names and saves the selected team identity', async () => {
  const h = screen();
  h.render();
  await h.settle();
  h.choose('selected');
  await h.click('Choose a team');
  assert.match(h.text(), /Release team/);
  h.find(node => node.props?.['aria-label'] === 'Team').props.onChange({ target: { value: 'teams-1' } });
  h.render();
  await h.click('Save landing policy');
  assert.deepEqual(h.state.policy.acceptance.withoutCheck.teams, ['teams-1']);
});
test('web retries the identical policy operation after a lost reply and Undo restores the earlier selection', async () => {
  const h = screen();
  h.render();
  await h.settle();
  h.choose('writers');
  h.state.fail = true;
  await h.click('Save landing policy');
  h.state.fail = false;
  await h.click('Retry save');
  const writes = h.calls.filter(call => call.name.endsWith(':set'));
  assert.equal(writes[0].input.command, writes[1].input.command);
  assert.equal(h.state.policy.acceptance.withoutCheck.mode, 'writers');
  await h.click('Undo');
  assert.equal(h.state.policy.acceptance.withoutCheck.mode, 'owner');
});
test('non-owner settings show the policy without offering an editing action', async () => {
  const h = screen(false);
  h.render();
  await h.settle();
  assert.equal(h.find(node => node.type === 'fieldset').props.disabled, true);
  assert(!h.nodes().some(node => node.type === 'button'));
});
