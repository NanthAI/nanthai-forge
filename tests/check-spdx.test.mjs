// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixSpdx, spdxFindings } from '../scripts/check-spdx.mjs';

const HEADER = '// SPDX-License-Identifier: Apache-2.0';

test('incident replay: an import added above the header fails and --fix moves the header up', () => {
  // f44ac5e0: agents inserted imports at line 1, pushing the header below them.
  const source = `import { a } from './a.js';\nimport { b } from './b.js';\n${HEADER}\nimport { c } from './c.js';\n`;
  const findings = spdxFindings('src/example.ts', source);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^src\/example\.ts:3: SPDX header must be the first line/);
  assert.ok(!findings[0].includes("'./a.js'"), 'findings never echo source');
  const fixed = fixSpdx(source);
  assert.equal(
    fixed,
    `${HEADER}\nimport { a } from './a.js';\nimport { b } from './b.js';\nimport { c } from './c.js';\n`,
  );
  assert.deepEqual(spdxFindings('src/example.ts', fixed), []);
});

test('a source file without any header fails and --fix adds the Apache-2.0 line', () => {
  const source = "import test from 'node:test';\n";
  assert.match(spdxFindings('tests/example.test.mjs', source)[0], /:1: missing SPDX header/);
  assert.equal(fixSpdx(source), `${HEADER}\n${source}`);
});

test('a shebang may precede the header; the fix keeps the shebang first', () => {
  assert.deepEqual(spdxFindings('src/cli.ts', `#!/usr/bin/env node\n${HEADER}\nimport x from 'x';\n`), []);
  const late = `#!/usr/bin/env node\nimport x from 'x';\n${HEADER}\n`;
  assert.equal(spdxFindings('src/cli.ts', late).length, 1);
  assert.equal(fixSpdx(late), `#!/usr/bin/env node\n${HEADER}\nimport x from 'x';\n`);
});

test('both project licenses and block comments pass; other files and generated code are skipped', () => {
  assert.deepEqual(spdxFindings('convex/a.ts', '// SPDX-License-Identifier: AGPL-3.0-only\n'), []);
  assert.deepEqual(spdxFindings('web/src/a.tsx', '/* SPDX-License-Identifier: Apache-2.0 */\n'), []);
  assert.equal(spdxFindings('src/a.ts', '// SPDX-License-Identifier: MIT\n').length, 1);
  for (const path of ['docs/a.md', 'package.json', 'convex/_generated/api.js', 'scripts/a.sh'])
    assert.deepEqual(spdxFindings(path, 'import x from "x";\n'), []);
});

test('verify runs the SPDX and env-print guards through the foundation check', () => {
  const foundation = readFileSync(new URL('../scripts/check-foundation.mjs', import.meta.url), 'utf8');
  assert.match(foundation, /errors\.push\(\.\.\.spdxFindings\(/);
  assert.match(foundation, /errors\.push\(\.\.\.envPrintFindings\(/);
  const verify = readFileSync(new URL('../scripts/verify.mjs', import.meta.url), 'utf8');
  assert.match(verify, /npm\('check', 'check'\)/);
});
