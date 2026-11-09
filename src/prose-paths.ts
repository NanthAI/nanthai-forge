// SPDX-License-Identifier: Apache-2.0
/** Which paths are documentation (prose no build or test reads) for every selector that skips them:
 * the package graph, package and runner test selection, and manifest placement. One rule, so a
 * dependency, build or fixture file is never skipped by one selector and run by another. When a path
 * is in doubt it is data: a wrong "data" costs a test run, a wrong "docs" skips the tests it feeds. */

/** `.txt` names that are prose; any other `.txt` (requirements, constraints, CMakeLists, fixtures,
 * golden files) is a build, dependency or test input. */
const PROSE_TEXT_NAME =
  /^(?:README|LICEN[CS]E|COPYING|NOTICE|THIRD[_-]PARTY[_-]NOTICES|CHANGELOG|CHANGES|HISTORY|AUTHORS|CONTRIBUTORS|CREDITS|SECURITY|CODE_OF_CONDUCT|llms(?:-full)?|robots|humans)(?:[._-][^/]*)?\.txt$/i;
/** Prose names that stay documentation inside a test folder. */
const PROSE_NAME = /^(?:README|CHANGELOG|CONTRIBUTING|LICEN[CS]E)(?:\.[^/]*)?$/i;
const PROSE_EXTENSION = /\.(?:md|mdx|rst|adoc)$/i;
/** Folders whose files tests read as data: fixtures, Go testdata, snapshots and golden files. */
const DATA_FOLDER =
  /(?:^|\/)(?:fixtures?|__fixtures__|testdata|test-data|test_data|__snapshots__|snapshots?|goldens?|golden-files)\//i;
const TEST_FOLDER = /(?:^|\/)(?:tests?|specs?|__tests__|testing|e2e)\//i;
const DOCS_FOLDER = /(?:^|\/)docs?\//i;

/** True for prose: Markdown, MDX, reStructuredText and AsciiDoc, and `.txt` only with a prose name or
 * under a docs folder. A file under a fixture or test-data folder is never documentation, and inside a
 * test folder only a README-style name is. */
export function documentationPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (DATA_FOLDER.test(path)) return false;
  if (TEST_FOLDER.test(path)) return PROSE_NAME.test(name);
  if (PROSE_EXTENSION.test(name)) return true;
  return /\.txt$/i.test(name) && (PROSE_TEXT_NAME.test(name) || DOCS_FOLDER.test(path));
}
