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
const classList = () => {
  const tokens = new Set();
  return {
    add: (...names) => names.forEach(name => tokens.add(name)),
    remove: (...names) => names.forEach(name => tokens.delete(name)),
    contains: name => tokens.has(name),
    toggle(name, force = !tokens.has(name)) {
      if (force) tokens.add(name);
      else tokens.delete(name);
      return Boolean(force);
    },
  };
};
Object.assign(globalThis, {
  self: globalThis,
  window: globalThis,
  // Browsers always expose Screen; orientation is optional (including older Safari).
  // Leave it absent so React Aria's module-level keyboard setup exercises that fallback.
  screen: {},
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
const element = () => ({ style: {}, classList: classList(), setAttribute() {}, addEventListener() {} });
globalThis.document = loose({
  getElementById: () => loose({ nodeType: 1, style: {}, appendChild() {}, addEventListener() {} }),
  createElement: element,
  createElementNS: element,
  createTextNode: () => ({}),
  createComment: () => ({}),
  addEventListener() {},
  documentElement: { style: {}, dataset: {}, classList: classList() },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementsByTagName: () => [],
  head: loose({}),
  body: loose({}),
});
// The entry chunk mounts React into the stub DOM; failures after it has loaded are the stub's limits, not the bundle's.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
