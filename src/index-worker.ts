// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { parentPort, workerData } from 'node:worker_threads';
import { indexRepository, type IndexSession } from './index.js';
import { ForgeError } from './errors.js';
const session: IndexSession = {};
parentPort?.on('message', () => {
  try {
    const { pack, elapsedMs, work } = indexRepository(String(workerData), undefined, session);
    parentPort?.postMessage({
      result: {
        sourceId: pack.source.id,
        analysisId: pack.id,
        files: pack.source.files.length,
        elapsedMs,
        work,
      },
    });
  } catch (error) {
    parentPort?.postMessage({
      error: {
        code: error instanceof ForgeError ? error.code : 'INDEX_FAILED',
        message: error instanceof ForgeError ? error.message : 'Indexer failed.',
      },
    });
  }
});
