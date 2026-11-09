// SPDX-License-Identifier: Apache-2.0
import type { Ecosystem } from './package-graph-types.js';

/** The test flags a project's own CI passes, read from the text of its declared check (the command's
 * words and the script files it names). Reading is lexical and never runs repository code. The package
 * runner (src/package-command-flags.ts) puts them back into the per-package commands, so a scoped run
 * is the CI's test step for fewer packages: `cargo test --all-features`, `go test -race -tags
 * integration`, `pytest -m "not slow"`, `dotnet test -c Release`, `./gradlew check`, `mvn verify`.
 * When the CI runs one tool in more than one way, or with a word Forge cannot place (a shell
 * variable, a flag whose value is unclear), the answer is `unsure` and the selection is full:
 * slower beats a run that differs from the CI's. */
export type CiFlags = {
  /** Flags that go before the package selection. */
  before: string[];
  /** Words after `--` (test-harness arguments), kept after the selection. */
  after: string[];
  /** The Gradle task or Maven phase the CI runs (`check`, `verify`) when it replaces `test`. */
  task?: string;
};
export type CiFlagResult = CiFlags | { unsure: string } | null;
export type FlagEcosystem = 'cargo' | 'go' | 'python' | 'dotnet' | 'gradle' | 'maven';
export const FLAG_ECOSYSTEMS: readonly Ecosystem[] = ['cargo', 'go', 'python', 'dotnet', 'gradle', 'maven'];

const list = (text: string) => new Set(text.split(' '));
/** Flags that take the next word as their value (`--features x`, `-tags x`, `-m expr`). */
const VALUE_FLAGS: Record<FlagEcosystem, Set<string>> = {
  cargo: list(
    '--features -F --target --profile --jobs -j --color --config --target-dir --message-format --test --bin --example --bench --exclude -p --package --manifest-path -Z --timings --lockfile-path',
  ),
  go: list(
    '-tags -run -count -timeout -parallel -p -cpu -bench -benchtime -skip -coverprofile -covermode -coverpkg -ldflags -gcflags -vet -exec -mod -o -outputdir -shuffle -fuzz -fuzztime -asmflags -pkgdir -toolexec -overlay -modfile',
  ),
  python: list(
    '-m -k -n -p -c -o -W -r --maxfail --tb --durations --durations-min --junitxml --rootdir --ignore --ignore-glob --deselect --timeout --import-mode --log-level --dist --basetemp --cov --cov-report --cov-config --cov-fail-under --override-ini --confcutdir --color --capture --verbosity --reruns --numprocesses --randomly-seed --splits --group',
  ),
  dotnet: list(
    '-c --configuration -f --framework --filter --logger -l -r --runtime -v --verbosity --results-directory -s --settings -a --arch --os -d --diag --blame-hang-timeout --collect --test-adapter-path -o --output',
  ),
  gradle: list(
    '-x --exclude-task -p --project-dir -c --settings-file -b --build-file -g --gradle-user-home -I --init-script --console --warning-mode --max-workers --priority --project-cache-dir --tests',
  ),
  maven: list(
    '-P --activate-profiles -T --threads -s --settings -gs --global-settings -t --toolchains -l --log-file -b --builder -rf --resume-from -pl --projects -f --file',
  ),
};
/** Flags known to take no value, so a plain word after them is not theirs. */
const BOOLEAN_FLAGS: Record<FlagEcosystem, Set<string>> = {
  cargo: list(
    '--release --all-features --no-default-features --no-fail-fast --lib --bins --tests --doc --benches --examples --locked --frozen --offline --verbose -v -vv --quiet -q --no-run --workspace --all',
  ),
  go: list('-race -v -short -cover -failfast -json -x -a -n -work -trimpath -msan -asan -benchmem -test.v'),
  python: list(
    '-x -q -qq -v -vv -vvv -s -ra -rA -rs -rf -rx -rE --strict-markers --strict-config --no-header --lf --ff --sw --pdb --disable-warnings --no-cov --cov-append --showlocals -l --co --collect-only --exitfirst --quiet --verbose',
  ),
  dotnet: list(
    '--no-build --no-restore --nologo --blame --list-tests --force --interactive --no-dependencies',
  ),
  gradle: list(
    '--no-daemon --daemon --stacktrace --full-stacktrace --info --debug --quiet -i -d -q -s -S --continue --parallel --no-parallel --build-cache --no-build-cache --offline --refresh-dependencies --rerun-tasks --scan --no-scan --configuration-cache --no-configuration-cache -i --warn -w',
  ),
  maven: list(
    '-B --batch-mode -ntp --no-transfer-progress -U --update-snapshots -e --errors -X --debug -q --quiet -o --offline -fae --fail-at-end -fn --fail-never -ff --fail-fast -V --show-version -N --non-recursive -nsu --no-snapshot-updates',
  ),
};
/** What the package runner selects itself: dropped from the CI's flags, with their value. */
const SELECTION: Record<FlagEcosystem, Set<string>> = {
  cargo: list('--workspace --all --exclude -p --package --manifest-path'),
  go: new Set(),
  python: list('--cov-fail-under'),
  dotnet: new Set(),
  gradle: list('--tests -p --project-dir -b --build-file -c --settings-file'),
  maven: list(
    '-pl --projects -am --also-make -amd --also-make-dependents -f --file -rf --resume-from -Dtest',
  ),
};
/** Tasks and phases that may surround the test task without changing what it tests. */
const TASKS: Record<'gradle' | 'maven', Set<string>> = {
  gradle: list('clean assemble classes testClasses build check test integrationTest'),
  maven: list('clean compile test-compile test package verify install integration-test'),
};

/** Words of one command line; quotes group a word (`-m "not slow"` is `-m`, `not slow`). */
function words(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g))
    found.push(match[0].replace(/"([^"]*)"|'([^']*)'/g, (_, a: string, b: string) => a ?? b));
  return found;
}
/** Logical command lines: continuations joined, split on `&&`, `||`, `;` and `|`, comments dropped. */
export function commandLines(text: string) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .flatMap(line => line.replace(/(^|\s)#.*$/, '').split(/&&|\|\||;|\|/))
    .map(line => line.trim())
    .filter(Boolean);
}

type Invocation = { ecosystem: FlagEcosystem; args: string[] };
const base = (word: string | undefined) => (word ?? '').split('/').pop()!;
/** The test invocation of a supported tool in one command line, after env assignments. */
function invocation(line: string): Invocation | null {
  const all = words(line);
  while (all.length && /^[A-Za-z_]\w*=/.test(all[0]!)) all.shift();
  const [first, second] = all;
  if (base(first) === 'cargo') {
    const rest = all.slice(1).filter((word, i) => !(i === 0 && word.startsWith('+')));
    return rest[0] === 'test' ? { ecosystem: 'cargo', args: rest.slice(1) } : null;
  }
  if (first === 'go' && second === 'test') return { ecosystem: 'go', args: all.slice(2) };
  if (first === 'dotnet' && second === 'test') return { ecosystem: 'dotnet', args: all.slice(2) };
  if (['pytest', 'py.test'].includes(base(first))) return { ecosystem: 'python', args: all.slice(1) };
  const at = all.findIndex((word, i) => base(word) === 'pytest' && ['-m', 'run'].includes(all[i - 1] ?? ''));
  if (at > 0) return { ecosystem: 'python', args: all.slice(at + 1) };
  if (['gradlew', 'gradle'].includes(base(first))) return { ecosystem: 'gradle', args: all.slice(1) };
  if (['mvn', 'mvnw'].includes(base(first))) return { ecosystem: 'maven', args: all.slice(1) };
  return null;
}

/** A word that plainly names what to test (a path, a node id, a task), never a flag's value. */
const target = (ecosystem: FlagEcosystem, word: string) =>
  /[/\\]|::|^\./.test(word) ||
  /\.(?:py|go|rs|csproj|sln|fsproj|vbproj)$/.test(word) ||
  ((ecosystem === 'gradle' || ecosystem === 'maven') && (word.startsWith(':') || TASKS[ecosystem].has(word)));

type Parsed = { before: string[]; after: string[]; positional: string[] };
function parse(ecosystem: FlagEcosystem, args: string[]): Parsed | string {
  const values = VALUE_FLAGS[ecosystem];
  const drop = SELECTION[ecosystem];
  const parsed: Parsed = { before: [], after: [], positional: [] };
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (/[$`]/.test(word)) return `${ecosystem} test word ${word.slice(0, 40)} uses a shell expansion`;
    if (word === '-args') return 'go test -args passes arguments Forge cannot place';
    if (word === '--') {
      parsed.after.push(...args.slice(i + 1));
      break;
    }
    const property = ecosystem === 'dotnet' && /^\/p(?:roperty)?:/i.test(word);
    if (!word.startsWith('-') && !property) {
      parsed.positional.push(word);
      continue;
    }
    const name = word.split('=')[0]!;
    // `-Dkey=value`, `-Pprop`, `-p:Prop=1`: one word.
    const attached =
      word.includes('=') ||
      property ||
      (ecosystem === 'maven' || ecosystem === 'gradle' ? /^-[DP]./.test(word) : false) ||
      (ecosystem === 'dotnet' && /^-p:/.test(word));
    const takesValue = !attached && values.has(name);
    const next = args[i + 1];
    if (takesValue && next === undefined) return `${ecosystem} flag ${word} has no value`;
    // An unknown flag followed by a plain word: the word may be its value, which Forge cannot tell.
    if (
      !attached &&
      !takesValue &&
      !BOOLEAN_FLAGS[ecosystem].has(name) &&
      next !== undefined &&
      !next.startsWith('-') &&
      !target(ecosystem, next)
    )
      return `${ecosystem} flag ${word} is followed by ${next.slice(0, 40)}, which may be its value`;
    if (!drop.has(name)) parsed.before.push(word, ...(takesValue ? [next!] : []));
    if (takesValue) i++;
  }
  return parsed;
}

/** Flags of the single way `text` runs `ecosystem`'s tests; null when it never does. */
export function ciFlags(text: string, ecosystem: FlagEcosystem): CiFlagResult {
  const runs: CiFlags[] = [];
  for (const line of commandLines(text)) {
    const found = invocation(line);
    if (found?.ecosystem !== ecosystem) continue;
    const parsed = parse(ecosystem, found.args);
    if (typeof parsed === 'string') return { unsure: parsed };
    let task: string | undefined;
    if (ecosystem === 'gradle' || ecosystem === 'maven') {
      const names = parsed.positional.map(word => word.split(':').pop()!);
      const other = names.find(name => !TASKS[ecosystem].has(name));
      if (other) return { unsure: `${ecosystem} runs ${other}, which Forge cannot scope to packages` };
      // Unqualified tasks only: `:app:test` already names its project.
      const plain = parsed.positional.filter(word => !word.startsWith(':'));
      task =
        ecosystem === 'gradle'
          ? plain.includes('check')
            ? 'check'
            : plain.includes('build')
              ? 'build'
              : undefined
          : ['verify', 'install', 'integration-test'].some(name => plain.includes(name))
            ? 'verify'
            : undefined;
    }
    runs.push({ before: parsed.before, after: parsed.after, ...(task ? { task } : {}) });
  }
  if (!runs.length) return null;
  const first = JSON.stringify(runs[0]);
  if (runs.some(run => JSON.stringify(run) !== first))
    return { unsure: `the CI runs ${ecosystem} tests in ${runs.length} different ways` };
  return runs[0]!;
}
