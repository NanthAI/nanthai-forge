// SPDX-License-Identifier: Apache-2.0
// Stub browser globals for scripts/web-smoke-load.mjs: just enough DOM for module-level code to evaluate.
const loose = base =>
  new Proxy(base, {
    get: (target, key) =>
      key in target
        ? target[key]
        : key === Symbol.iterator
          ? function* () {}
          : key === 'then'
            ? undefined
            : loose(function () {
                return loose({});
              }),
    apply: () => loose({}),
  });
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.assign(globalThis, {
  self: globalThis,
  window: globalThis,
  localStorage: storage,
  sessionStorage: storage,
  location: new URL('https://forge.invalid/device'),
  history: { pushState() {}, replaceState() {}, state: null },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
});
globalThis.ResizeObserver = globalThis.IntersectionObserver = globalThis.MutationObserver;
const element = () => ({ style: {}, setAttribute() {}, addEventListener() {} });
globalThis.document = loose({
  getElementById: () => loose({ nodeType: 1, style: {}, appendChild() {}, addEventListener() {} }),
  createElement: element,
  createElementNS: element,
  createTextNode: () => ({}),
  createComment: () => ({}),
  addEventListener() {},
  documentElement: { style: {}, dataset: {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementsByTagName: () => [],
  head: loose({}),
  body: loose({}),
});
// The entry chunk mounts React into the stub DOM; failures after it has loaded are the stub's limits, not the bundle's.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
