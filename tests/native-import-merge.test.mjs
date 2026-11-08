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
    "export const fs = require('node:fs');\n",
    "export let fs = require('node:fs');\n",
    "export var fs = require('node:fs');\n",
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

// Any-ecosystem fix-up (Issue 60ff8adb): two Lanes adding the same import at
// different positions compose once, where a duplicate would fail the build.
const both = (original, left, right, path) =>
  mergeNativeText(Buffer.from(original), Buffer.from(left), Buffer.from(right), path)?.toString() ?? null;
const count = (text, line) => text.split('\n').filter(row => row === line).length;

test('the same "os" added by both sides in a Go import block composes once', () => {
  const original = 'package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc main() {}\n';
  const result = both(
    original,
    original.replace('\t"fmt"\n', '\t"fmt"\n\t"os"\n'),
    original.replace('\t"strings"\n', '\t"strings"\n\t"os"\n'),
    'cmd/main.go',
  );
  assert.equal(result, original.replace('\t"fmt"\n', '\t"fmt"\n\t"os"\n'));
  // Single-line import declarations and aliased specs are read too.
  const flat = 'package main\n\nimport "fmt"\n\nfunc a() {}\n\nfunc b() {}\n';
  const added = 'import f "os"\n';
  const merged = both(
    flat,
    flat.replace('import "fmt"\n', 'import "fmt"\n' + added),
    flat.replace('import "fmt"\n', added + 'import "fmt"\n'),
    'a.go',
  );
  assert.equal(count(merged, added.trimEnd()), 1);
});

test('Go fix-up stays out of function bodies, block comments and cgo', () => {
  const original = 'package main\n\nimport "fmt"\n\nfunc a() {\n}\n\nfunc b() {\n}\n';
  const line = '\t"os"\n';
  // Lines after the prologue are not imports and are never removed.
  const body = both(
    original,
    original.replace('func a() {\n', 'func a() {\n' + line),
    original.replace('func b() {\n', 'func b() {\n' + line),
    'a.go',
  );
  assert.equal(count(body, '\t"os"'), 2);
  const commented = 'package main\n\n/*\nimport "os"\n*/\nimport "fmt"\n\nfunc a() {}\n';
  const prefixed = both(
    commented,
    commented.replace('import "fmt"\n', 'import "fmt"\nimport "os"\n'),
    commented.replace('*/\n', '*/\nimport "os"\n'),
    'a.go',
  );
  assert.equal(count(prefixed, 'import "os"'), 2, 'the commented line stays and one import remains');
  // `import "C"` is bound to the cgo comment above it: an ambiguous duplicate conflicts.
  const cgo = 'package main\n\nimport "fmt"\n\nfunc a() {}\n';
  assert.equal(
    both(
      cgo,
      cgo.replace('import "fmt"\n', 'import "C"\nimport "fmt"\n'),
      cgo.replace('import "fmt"\n', 'import "fmt"\nimport "C"\n'),
      'a.go',
    ),
    null,
  );
});

test('the same `use std::io;` in Rust composes once', () => {
  const original =
    '//! Crate docs.\n#![allow(dead_code)]\nmod util;\nuse std::fmt;\n\nfn a() {}\n\nfn b() {}\n';
  const line = 'use std::io;\n';
  const result = both(
    original,
    original.replace('use std::fmt;\n', line + 'use std::fmt;\n'),
    original.replace('use std::fmt;\n', 'use std::fmt;\n' + line),
    'src/lib.rs',
  );
  assert.equal(result, original.replace('use std::fmt;\n', line + 'use std::fmt;\n'));
  // A use bound to an attribute, or a multiline use, could change meaning: a conflict.
  const attributed = '#[cfg(test)]\nuse std::io;\n';
  assert.equal(
    both(
      original,
      attributed + original,
      original.replace('mod util;\n', 'mod util;\n' + attributed),
      'a.rs',
    ),
    null,
  );
  const multiline = 'use std::{\n    io,\n};\n';
  assert.equal(
    both(original, multiline + original, original.replace('mod util;\n', 'mod util;\n' + multiline), 'a.rs'),
    null,
  );
  // Lines inside function bodies and block comments are not imports.
  const body = 'fn a() {\n}\n\nfn b() {\n}\n';
  const scoped = both(
    body,
    body.replace('fn a() {\n', 'fn a() {\n    use std::io;\n'),
    body.replace('fn b() {\n', 'fn b() {\n    use std::io;\n'),
    'a.rs',
  );
  assert.equal(count(scoped, '    use std::io;'), 2);
  const commented = '/* use std::io;\n*/ fn x() {}\nuse std::fmt;\n';
  const stopped = both(
    commented,
    commented + line,
    commented.replace('use std::fmt;\n', line + 'use std::fmt;\n'),
    'a.rs',
  );
  assert.equal(count(stopped, 'use std::io;'), 2, 'a comment that closes mid-line ends the prologue');
});

test('Python, Java and C# imports added by both sides compose once', () => {
  const py = 'import sys\n\n\ndef a():\n    pass\n\n\ndef b():\n    pass\n';
  const pyLine = 'from os import path\n';
  assert.equal(
    both(py, pyLine + py, py.replace('import sys\n', 'import sys\n' + pyLine), 'pkg/mod.py'),
    pyLine + py,
  );
  const documented =
    '"""Module docs.\n\nimport os\n"""\nfrom __future__ import annotations\nimport sys\n\nx = 1\n';
  const docLine = 'import os\n';
  const doc = both(
    documented,
    documented.replace('import sys\n', docLine + 'import sys\n'),
    documented.replace('import sys\n', 'import sys\n' + docLine),
    'a.py',
  );
  assert.equal(count(doc, 'import os'), 2, 'the docstring line stays and one import remains');
  // Imports inside a function are scoped and stay as merged.
  const local = '    import json\n';
  assert.equal(
    count(
      both(
        py,
        py.replace('def a():\n', 'def a():\n' + local),
        py.replace('def b():\n', 'def b():\n' + local),
        'a.py',
      ),
      '    import json',
    ),
    2,
  );
  const java = 'package a;\n\nimport java.util.Map;\n\nclass A {\n}\n';
  const javaLine = 'import java.util.List;\n';
  assert.equal(
    both(
      java,
      java.replace('package a;\n\n', 'package a;\n\n' + javaLine),
      java.replace('Map;\n', 'Map;\n' + javaLine),
      'A.java',
    ),
    java.replace('package a;\n\n', 'package a;\n\n' + javaLine),
  );
  const cs = 'using System;\nusing System.IO;\n\nnamespace A;\n\nclass B {}\n';
  const csLine = 'using System.Linq;\n';
  assert.equal(
    both(cs, csLine + cs, cs.replace('System.IO;\n', 'System.IO;\n' + csLine), 'B.cs'),
    csLine + cs,
  );
});

test('a harmless ambiguous duplicate stays merged; one that breaks the build conflicts', () => {
  // C#: a preprocessor line can make a using conditional, so nothing is removed (a duplicate is only a warning).
  const cs = '#if DEBUG\nusing System.Diagnostics;\n#endif\nusing System;\n\nclass B {}\n';
  const line = 'using System.Linq;\n';
  assert.equal(
    count(
      both(cs, line + cs, cs.replace('using System;\n', 'using System;\n' + line), 'B.cs'),
      line.trimEnd(),
    ),
    2,
  );
  // Python: a multiline import is not removed and the merge is kept.
  const py = 'import sys\n\nx = 1\n\ny = 2\n';
  const multi = 'from os import (\n    path,\n)\n';
  assert.notEqual(both(py, multi + py, py + multi, 'a.py'), null);
});
