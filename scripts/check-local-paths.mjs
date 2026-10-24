// SPDX-License-Identifier: Apache-2.0
// Report locations only: diagnostics must never echo potentially private source.
const localHome = /\/(?:Users|home)\/[^/\s]+\//;
const fixtureMarker = /^\s*(?:\/\/|#|<!--)\s*forge-path-fixture: synthetic(?:\s*-->)?\s*$/;

export function localPathFindings(path, bytes) {
  if (bytes.includes(0)) return [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return []; // Binary files are outside this text-source check.
  }
  const fixture = path.startsWith('tests/fixtures/') || /^tests\/[^/]+\.test\.mjs$/.test(path);
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!localHome.test(line)) return [];
    // A marker exempts exactly the next line, and only inside synthetic tests.
    if (fixture && index > 0 && fixtureMarker.test(lines[index - 1])) return [];
    return [`${path}:${index + 1}: machine-specific home path; use a relative path or placeholder`];
  });
}
