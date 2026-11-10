// SPDX-License-Identifier: Apache-2.0
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { daySummary, utcDay } from './convex-spend-model.mjs';

/** Append-only numeric day journals are both the restart ledger and the report source. */
export class SpendJournal {
  constructor(directory) {
    this.directory = directory;
    this.days = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async load(day) {
    if (!this.days.has(day)) this.days.set(day, this.readDay(day));
    return this.days.get(day);
  }
  async readDay(day) {
    const state = { rows: [], seen: new Set(), needsNewline: false };
    const file = join(this.directory, `${day}.jsonl`);
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size) {
        const fd = openSync(file, 'r'),
          last = Buffer.alloc(1);
        try {
          readSync(fd, last, 0, 1, size - 1);
          state.needsNewline = last[0] !== 10;
        } finally {
          closeSync(fd);
        }
      }
      let partial = false;
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row.kind === 'execution') {
            if (state.seen.has(row.id)) continue;
            state.seen.add(row.id);
          }
          state.rows.push(row);
        } catch {
          partial = true;
        }
      }
      if (partial)
        state.rows.push({
          kind: 'gap',
          deployment: '(journal)',
          at: Date.now(),
          reason: 'torn-or-invalid-journal-record',
        });
    }
    return state;
  }
  async append(row, day = utcDay(row.at ?? row.to ?? Date.now())) {
    const state = await this.load(day);
    if (row.kind === 'execution' && state.seen.has(row.id)) return false;
    const prefix = state.needsNewline ? '\n' : '';
    appendFileSync(join(this.directory, `${day}.jsonl`), prefix + JSON.stringify(row) + '\n', {
      mode: 0o600,
      flush: true,
    });
    state.needsNewline = false;
    if (row.kind === 'execution') state.seen.add(row.id);
    state.rows.push(row);
    // Retain only active/replayed days; history stays on disk without a retention policy.
    for (const key of this.days.keys())
      if (key < utcDay(Date.now() - 86_400_000) && key !== day) this.days.delete(key);
    return true;
  }
  async gap(deployment, reason, at = Date.now()) {
    return this.append({ kind: 'gap', deployment, at, reason });
  }
  async coverage(deployment, from, to) {
    while (from < to) {
      const end = Math.min(to, Date.parse(utcDay(from)) + 86_400_000);
      await this.append({ kind: 'coverage', deployment, from, to: end }, utcDay(from));
      from = end;
    }
  }
  writeSummary(report) {
    const path = join(this.directory, `${report.day}.summary.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
  }
  async report(day = utcDay(Date.now()), now = Date.now()) {
    return daySummary(day, (await this.load(day)).rows, now);
  }
}

/** An OS-released SQLite transaction fences competing writers, including after a crash. */
export function journalLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'writer.sqlite'));
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    throw Error(error.errcode === 5 ? 'SPEND_WRITER_RUNNING' : 'SPEND_JOURNAL_LOCK');
  }
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}

export function privateConfig(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Error('SPEND_CONFIG_UNREADABLE');
  }
}
