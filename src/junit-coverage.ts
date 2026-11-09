// SPDX-License-Identifier: Apache-2.0
/** Which JUnit report entries cover a test file when the reporter names no `file` (Issue b94681af,
 * M2-03). Go reporters (gotestsum, go-junit-report) name the import path of the package, Maven
 * Surefire and Gradle name the class (`com.acme.LedgerTest`), cargo-nextest names `crate::binary`.
 * The owning entry is found from the file's own path and, where the language needs it, its module
 * or package declaration, read as text from the checkout: Go covers a test file at package
 * granularity (`go test` runs the whole package), JVM at class granularity and Rust at test-binary
 * granularity. An entry Forge cannot attribute to the file with certainty covers nothing, so the
 * union test runs again: unsure widens. Pure and dependency-free: the check wrapper loads this
 * module on its own from the shipped payload (src/semantic-check-command.ts). */
export type CoverageFiles = {
  /** Text of a repository file (relative path), or undefined when absent or unreadable. */
  read(path: string): string | undefined;
};

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stem = (path: string) => basename(path).replace(/\.[^.]+$/, '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The nearest file named `name` in `path`'s folder or above it, with its folder. */
function nearest(path: string, name: string, files: CoverageFiles) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = files.read(join(dir, name));
    if (text !== undefined) return { dir, text };
    if (!dir) return null;
  }
}

/** Report entry names that cover `test`, from a list of entry names. Empty: not attributable. */
export function coveringEntries(test: string, entries: Iterable<string>, files: CoverageFiles): string[] {
  const names = [...entries];
  const exact = (...wanted: string[]) => names.filter(name => wanted.includes(name));
  const prefixed = (...bases: string[]) =>
    names.filter(name =>
      bases.some(base => name === base || (/^[$.]/.test(name.slice(base.length)) && name.startsWith(base))),
    );
  if (test.endsWith('_test.go')) {
    const dir = dirname(test);
    const owner = nearest(test, 'go.mod', files);
    const module = owner ? /^\s*module\s+(\S+)/m.exec(owner.text)?.[1] : undefined;
    if (!owner || !module) return exact(dir, `./${dir}`);
    const rel = dir === owner.dir ? '' : dir.slice(owner.dir ? owner.dir.length + 1 : 0);
    const path = rel ? `${module}/${rel}` : module;
    return exact(path, `${path}_test`);
  }
  if (/\.(?:java|kts?|scala|groovy)$/.test(test)) {
    const text = files.read(test)?.slice(0, 8192);
    const declared = /^\s*package\s+([\w.]+)/m.exec(text ?? '')?.[1];
    const layout = /(?:^|\/)src\/[^/]+\/(?:java|kotlin|scala|groovy)\/(.+)\.\w+$/
      .exec(test)?.[1]
      ?.replaceAll('/', '.');
    // A file with no package declaration is in the default package: the class is its file name.
    const name = declared ? `${declared}.${stem(test)}` : text !== undefined ? stem(test) : layout;
    return name ? prefixed(name) : [];
  }
  if (test.endsWith('.rs')) {
    const owner = nearest(test, 'Cargo.toml', files);
    const crate = owner ? /\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(owner.text)?.[1] : undefined;
    if (!crate || !owner) return [];
    const below = test.slice(owner.dir ? owner.dir.length + 1 : 0);
    // `tests/NAME.rs` and `tests/NAME/main.rs` are the test binary NAME; other files belong to the crate's own binaries.
    const binary = /^tests\/([^/]+)\.rs$/.exec(below)?.[1] ?? /^tests\/([^/]+)\/main\.rs$/.exec(below)?.[1];
    const crates = [crate, crate.replaceAll('-', '_')];
    return binary ? exact(...crates.map(name => `${name}::${binary}`)) : exact(...crates);
  }
  return [];
}
