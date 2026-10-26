// SPDX-License-Identifier: Apache-2.0
/** Extract reported failures, never infer that every file assigned to a shard failed. */
export function failedTestFiles(text: string): string[] {
  const files = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
    const named = /^(?:# |\[test\] )?Failed test file:\s*(.+)$/.exec(line);
    if (named) files.add(named[1]!.trim());
    const marker = /^(__FORGE_TEST_FAILURE__|__FORGE_TESTS__)(.*)$/.exec(line);
    if (!marker) continue;
    try {
      const report = JSON.parse(marker[2]!);
      if (
        typeof report.file === 'string' &&
        (marker[1] === '__FORGE_TEST_FAILURE__' ||
          report.results?.some((result: { passed?: boolean }) => result?.passed === false))
      )
        files.add(report.file);
    } catch {
      // An incomplete log marker cannot name a failure.
    }
  }
  return [...files];
}
