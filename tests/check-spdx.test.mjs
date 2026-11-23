// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixSpdx, spdxFindings } from '../scripts/check-spdx.mjs';

const COPY = '// Copyright 2026 Ferdinando Valsecchi';
const HEADER = `// SPDX-License-Identifier: AGPL-3.0-only\n${COPY}`;

test('incident replay: an import added above the header fails and --fix moves the header up', () => {
  // f44ac5e0: agents inserted imports at line 1, pushing the header below them.
  const source = `import { a } from './a.js';\nimport { b } from './b.js';\n// SPDX-License-Identifier: AGPL-3.0-only\nimport { c } from './c.js';\n`;
  const findings = spdxFindings('src/example.ts', source);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^src\/example\.ts:3: SPDX header must be the first line/);
  assert.ok(!findings[0].includes("'./a.js'"), 'findings never echo source');
  const fixed = fixSpdx(source, 'src/example.ts');
  assert.equal(
    fixed,
    `${HEADER}\nimport { a } from './a.js';\nimport { b } from './b.js';\nimport { c } from './c.js';\n`,
  );
  assert.deepEqual(spdxFindings('src/example.ts', fixed), []);
});

test('a source file without any header fails and --fix adds the AGPL-3.0-only lines', () => {
  const source = "import test from 'node:test';\n";
  assert.match(spdxFindings('tests/example.test.mjs', source)[0], /:1: missing SPDX header/);
  assert.equal(fixSpdx(source, 'tests/example.test.mjs'), `${HEADER}\n${source}`);
});

test('a shebang may precede the header; the fix keeps the shebang first', () => {
  assert.deepEqual(spdxFindings('src/cli.ts', `#!/usr/bin/env node\n${HEADER}\nimport x from 'x';\n`), []);
  const late = `#!/usr/bin/env node\nimport x from 'x';\n// SPDX-License-Identifier: AGPL-3.0-only\n`;
  assert.equal(spdxFindings('src/cli.ts', late).length, 1);
  assert.equal(fixSpdx(late, 'src/cli.ts'), `#!/usr/bin/env node\n${HEADER}\nimport x from 'x';\n`);
});

test('Item ffb6cc49: an Apache-2.0 header fails, names the one-line fix, and --fix converts it', () => {
  const source = `// SPDX-License-Identifier: Apache-2.0\nimport x from 'x';\n`;
  const [finding] = spdxFindings('src/a.ts', source);
  assert.match(
    finding,
    /^src\/a\.ts:1: Apache-2\.0 header; the project licence is AGPL-3\.0-only\. One-line fix: make line 1 "\/\/ SPDX-License-Identifier: AGPL-3\.0-only"/,
  );
  assert.equal(fixSpdx(source, 'src/a.ts'), `${HEADER}\nimport x from 'x';\n`);
  assert.equal(spdxFindings('web/src/a.css', '/* SPDX-License-Identifier: Apache-2.0 */\n').length, 1);
  assert.equal(
    spdxFindings('web/a.html', '<!doctype html>\n<!-- SPDX-License-Identifier: Apache-2.0 -->\n').length,
    1,
  );
});

test('Item ffb6cc49: the copyright line follows the header; other licences and kinds stay out', () => {
  assert.equal(
    spdxFindings('src/a.ts', '// SPDX-License-Identifier: AGPL-3.0-only\nimport x from "x";\n').length,
    1,
  );
  assert.deepEqual(
    spdxFindings(
      'web/src/a.css',
      '/* SPDX-License-Identifier: AGPL-3.0-only */\n/* Copyright 2026 Ferdinando Valsecchi */\n',
    ),
    [],
  );
  assert.deepEqual(
    spdxFindings(
      'scripts/a.py',
      '# SPDX-License-Identifier: AGPL-3.0-only\n# Copyright 2026 Ferdinando Valsecchi\n',
    ),
    [],
  );
  assert.equal(spdxFindings('src/a.ts', '// SPDX-License-Identifier: MIT\n').length, 1);
  for (const path of [
    'docs/a.md',
    'package.json',
    'convex/_generated/api.js',
    'convex/components/authPasskey/_generated/api.ts',
    'docs/vendor-notices/x/a.js',
    'tests/fixtures/a.py',
  ])
    assert.deepEqual(spdxFindings(path, 'import x from "x";\n'), []);
});

test('Item ffb6cc49 review: the fix removes only the header comment, accepts CRLF and ignores template text', () => {
  const css = '/* SPDX-License-Identifier: Apache-2.0 */ a { color: red; }\n';
  assert.equal(
    fixSpdx(css, 'web/a.css'),
    css.replace(
      '/* SPDX-License-Identifier: Apache-2.0 */ a',
      '/* SPDX-License-Identifier: AGPL-3.0-only */\n/* Copyright 2026 Ferdinando Valsecchi */\n/* SPDX-License-Identifier: Apache-2.0 */ a',
    ),
  );
  const template = 'const x = `\n# SPDX-License-Identifier: Apache-2.0\n`;\n';
  assert.equal(fixSpdx(template, 'src/a.ts'), `${HEADER}\n${template}`);
  const crlf = `${HEADER.replaceAll('\n', '\r\n')}\r\nimport x from 'x';\r\n`;
  assert.deepEqual(spdxFindings('src/a.ts', crlf), []);
  assert.equal(fixSpdx(crlf, 'src/a.ts'), crlf);
});

test('Item ffb6cc49: core queue paths carry the AGPL header like any file; only the brand styles stay exempt', () => {
  const apache = '// SPDX-License-Identifier: Apache-2.0\n';
  assert.deepEqual(spdxFindings('web/src/ui/brand.tsx', apache), []);
  for (const path of ['convex/projectHostedFinish.ts', 'src/hosted-finish.ts', 'convex/projectAccess.ts'])
    assert.equal(spdxFindings(path, apache).length, 1, path);
});

test('Item ffb6cc49: the guard finds no Apache-2.0 or missing header in any original file of the tree', () => {
  // The script walks the whole tree itself; a failing file exits 1 and names the file and the fix on stderr.
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/check-spdx.mjs', import.meta.url))],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr.split('\n').slice(0, 5).join('\n'));
  assert.match(result.stdout, /check-spdx: 0 file\(s\) failing/);
});

test('verify runs the SPDX and env-print guards through the foundation check', () => {
  const foundation = readFileSync(new URL('../scripts/check-foundation.mjs', import.meta.url), 'utf8');
  assert.match(foundation, /errors\.push\(\.\.\.spdxFindings\(/);
  assert.match(foundation, /errors\.push\(\.\.\.envPrintFindings\(/);
  const verify = readFileSync(new URL('../scripts/verify.mjs', import.meta.url), 'utf8');
  assert.match(verify, /npm\('check', 'check'\)/);
});
