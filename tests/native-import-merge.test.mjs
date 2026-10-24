// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mergeNativeText } from '../dist/native-text-merge.js';

const base = "import { join } from 'node:path';\nexport const value = 1;\n";
const merge = (original, added) =>
  mergeNativeText(
    Buffer.from(original),
    Buffer.from(added + original),
    Buffer.from(original + added),
    'file.mjs',
  );

test('different-position static import merge retains valid JavaScript syntax', () => {
  const added = "import { readFileSync } from 'node:fs';\n",
    result = merge(base, added);
  assert.equal(result?.toString(), added + base);
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: result });
  assert.equal(checked.status, 0, checked.stderr?.toString());
});

test('wrapped requires and multiline imports become explicit conflicts', () => {
  for (const added of [
    "const fs = require('node:fs').promises;\n",
    "const fs = (require('node:fs'));\n",
    "const fs = await require('node:fs');\n",
    "globalThis.fs = require('node:fs');\n",
    "import {\n  readFileSync,\n} from 'node:fs';\n",
    "const {\n  readFileSync,\n} = require('node:fs');\n",
  ])
    assert.equal(merge(base, added), null, added);
});

test('import-looking text in a base literal does not mask new duplicate declarations', () => {
  const added = "import { readFileSync } from 'node:fs';\n",
    original = 'const example = `\n' + added + '`;\n' + base;
  assert.equal(merge(original, added)?.toString(), added + original);
});

test('new copies of an existing declaration stay ambiguous rather than silently deleting source', () => {
  const added = "import { readFileSync } from 'node:fs';\n";
  assert.equal(merge(added + base, added), null);
});

test('import reconciliation preserves CRLF and conflicts on ambiguous line separators', () => {
  const added = "import { readFileSync } from 'node:fs';\n",
    original = base.replaceAll('\n', '\r\n'),
    crlf = added.replace('\n', '\r\n');
  assert.equal(merge(original, crlf)?.toString(), crlf + original);
  for (const separator of ['\r', '\u2028', '\u2029']) {
    assert.equal(merge(base + 'const text = 1;' + separator + 'const more = 2;\n', added), null);
  }
});

test('an identical added import at EOF is reconciled without a final newline', () => {
  const added = "import { readFileSync } from 'node:fs';\n";
  assert.equal(
    mergeNativeText(
      Buffer.from(base),
      Buffer.from(added + base),
      Buffer.from(base + added.trimEnd()),
      'file.mjs',
    )?.toString(),
    added + base,
  );
});
