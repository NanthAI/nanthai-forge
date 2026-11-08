// SPDX-License-Identifier: Apache-2.0
/** Glob with `**`, `*`, `?` and `{a,b}`; `/` separates segments. Enough for path scoping. */
export function globRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) source += '\\{';
      else {
        source += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map(part => globRegExp(part).source.slice(1, -1))
          .join('|')})`;
        i = end;
      }
    } else source += /[\\^$.|+()[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}
