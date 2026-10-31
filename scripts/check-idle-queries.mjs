// SPDX-License-Identifier: Apache-2.0
// Idle tabs must cost nothing: a live query argument that changes with the clock re-subscribes (and re-runs)
// the query on a timer for every open tab. Queries re-run on server writes only.
const queryCall = /\b(?:useQuery|usePaginatedQuery|useQueries|watchQuery)\s*\(/g;
const clockBinding = /\b(?:const|let)\s+(\w+)\s*=\s*useNow\s*\(/g;
const clockUse = /\bDate\.now\s*\(|\bnew Date\s*\(|\bperformance\.now\s*\(|\brefreshKey\b/;

/** Text of the balanced parentheses that open at `open`. */
function callText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Locations only (path:line): diagnostics never echo source. */
export function idleQueryFindings(path, text) {
  if (!/\.(?:ts|tsx)$/.test(path) || /\.test\./.test(path)) return [];
  const clocks = [...text.matchAll(clockBinding)].map(match => new RegExp(`\\b${match[1]}\\b`));
  const lineOf = index => text.slice(0, index).split('\n').length;
  const found = [];
  if (path.startsWith('web/src/'))
    for (const match of text.matchAll(queryCall)) {
      const call = callText(text, match.index + match[0].length - 1);
      if (clockUse.test(call) || clocks.some(clock => clock.test(call)))
        found.push(
          `${path}:${lineOf(match.index)}: live query argument derives from the clock; queries must re-run on server writes only (idle tabs cost nothing)`,
        );
    }
  // A server arg that exists only to be bumped by the client has no other use.
  if (path.startsWith('convex/') || path.startsWith('web/src/'))
    for (const match of text.matchAll(/\brefreshKey\b/g))
      found.push(`${path}:${lineOf(match.index)}: refreshKey re-runs queries on a timer; remove it`);
  return [...new Set(found)];
}
