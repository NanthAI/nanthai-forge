// SPDX-License-Identifier: Apache-2.0
// Foreground synthetic benchmark; optional --baseline-head pins the pre-change record reader.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { intentLoadFixture } from './intent-load-fixture.mjs';
import { convertWork15To16, convertWorkTo18 } from '../dist/work-intent-converter.js';
import { writeRecords } from '../dist/work-records.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource, nativeOwner } from '../dist/native-source.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-intent-load-'))),
  generated = [];
try {
  const readers = [{ name: 'after', Store: WorkStore, write: writeRecords }];
  const flag = process.argv.indexOf('--baseline-head');
  const baselineHead = flag < 0 ? undefined : process.argv[flag + 1];
  if (flag >= 0) {
    const source = new NativeSource(nativeOwner(process.cwd())),
      state = source.state(baselineHead);
    const baselineCode = path => {
      const file = state.files.find(file => file.path === path);
      if (!file) throw Error(`Baseline source has no ${path}`);
      return source.object(file.blob).toString('utf8');
    };
    const stem = `work-records-benchmark-${process.pid}`;
    const compile = (name, code) => {
      const path = fileURLToPath(new URL(`../dist/${name}.js`, import.meta.url));
      generated.push(path);
      writeFileSync(
        path,
        ts.transpileModule(code, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
      return path;
    };
    const baselineModule = await import(
      pathToFileURL(compile(stem, baselineCode('src/work-records.ts'))).href
    );
    compile(`${stem}-normalization`, baselineCode('src/work-normalization.ts'));
    const storeCode = baselineCode('src/work-store.ts')
      .replace("'./work-records.js'", `'./${stem}.js'`)
      .replace("'./work-normalization.js'", `'./${stem}-normalization.js'`);
    const module = await import(
      pathToFileURL(compile(`work-store-benchmark-${process.pid}`, storeCode)).href
    );
    readers.unshift({ name: 'before', Store: module.WorkStore, write: baselineModule.writeRecords });
  }
  const data15 = intentLoadFixture(),
    data16 = convertWork15To16(data15),
    data18 = convertWorkTo18(data15),
    stores = [];
  for (const data of [data15, data16, data18]) {
    for (const { name, Store, write } of readers) {
      const directory = join(root, `${name}-${data.schema}`);
      mkdirSync(directory);
      initNative(directory);
      const store = new Store(directory);
      write(store.directory, data);
      stores.push({ name, schema: data.schema, store, count: data.intents.length, samples: [] });
    }
  }
  for (let repeat = 0; repeat < 6; repeat++) {
    // Alternate baseline and revised stores with identical portable data to avoid order bias.
    const order = repeat % 2 ? [...stores].reverse() : stores;
    for (const entry of order) {
      const start = performance.now(),
        loaded = entry.store.load(),
        ms = performance.now() - start;
      if (loaded.intents.length !== entry.count || loaded.schema !== entry.schema)
        throw Error('Incomplete hydration');
      if (repeat) entry.samples.push(ms);
    }
  }
  const results = stores.map(({ name, schema, samples }) => ({
    reader: name,
    schema,
    samplesMs: samples.map(n => Math.round(n)),
    medianMs: Math.round([...samples].sort((a, b) => a - b)[2]),
  }));
  console.log(
    JSON.stringify(
      {
        fixture: 'anonymous owner topology: 250 Intents, 210 Lanes, 553 Views',
        method:
          'WorkStore.load, five warm samples, alternating baseline/revised stores with identical portable data',
        baselineHead,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const path of generated) rmSync(path, { force: true });
  rmSync(root, { recursive: true, force: true });
}
