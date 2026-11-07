// SPDX-License-Identifier: Apache-2.0
// Tests that read a changed Markdown file. A test that reads a document's text can fail on a docs-only
// edit (a removed phrase it asserts, a renamed heading it parses), so that test is the document's
// coverage. Everything else a docs-only change can break is a static check (the documents check,
// format), which runs on every Candidate. Text only: no graph parse, no process, no server call.

const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
// Packagers and their manifests list every document; the documents check runs them.
const packager = path => /^package(?:-lock)?\.json$|^scripts\/package-/.test(path);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stem = path => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** A file names a document by its repository path (`docs/a.md`, `../docs/a.md`); `docs/a.md` inside
 * `other/docs/a.md` is a different file, so a path starts at a word boundary or `./`/`../`. A root
 * document needs a relative prefix (`../GUIDE.md`), or its quoted name in a file that resolves names
 * against the repository root (`` new URL(`../${name}`, import.meta.url) ``): a bare `'GUIDE.md'` is
 * what fixtures call their own files. Segments joined at run time (`join(root, 'docs', name)`) are
 * not a read: tests build synthetic documents that way, and build real paths so on purpose. */
const quoted = value => new RegExp(`['"\`]${escape(value)}['"\`]`);
const rootRelative = /`(?:\.\.\/)+\$\{/;
const mentions = doc => {
  const root = !doc.includes('/');
  const path = new RegExp(`(?:^|[^\\w./-])(?:\\.{1,2}/)${root ? '+' : '*'}${escape(doc)}(?![\\w/-])`);
  const name = root && quoted(doc);
  return text => path.test(text) || (!!name && rootRelative.test(text) && name.test(text));
};

/** Test files that read one of `docs`: they name it, or load a test helper or script that names it
 * (one hop, by file name; a doubtful match selects the test). Product code that names a document
 * links to it in a message; it does not read its text. Returns test -> the document and the file that
 * names it. */
export function docsReaders(files, docs) {
  const found = new Map();
  if (!docs.length) return found;
  const patterns = docs.map(doc => [doc, mentions(doc)]);
  const tests = [...files.keys()].filter(testFile).sort();
  const carriers = [];
  for (const [path, text] of files) {
    if (packager(path) || !/^(?:tests|scripts)\//.test(path) || typeof text !== 'string') continue;
    const doc = patterns.find(([, named]) => named(text))?.[0];
    if (!doc) continue;
    if (testFile(path)) found.set(path, { doc, via: path });
    else carriers.push({ path, doc, loaded: new RegExp(`/${escape(stem(path))}\\.[cm]?[jt]sx?['"\`]`) });
  }
  for (const { path, doc, loaded } of carriers)
    for (const test of tests)
      if (!found.has(test) && loaded.test(files.get(test))) found.set(test, { doc, via: path });
  return found;
}
