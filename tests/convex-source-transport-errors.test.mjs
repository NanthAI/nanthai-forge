// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { ForgeError } from '../dist/errors.js';
import { SourceIoError } from '../dist/hosted-source-io-error.js';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));

for (const method of ['describeBatch', 'probeStates'])
  test(`${method}: normalize structured domain failures, retaining authority and transient escape paths`, async () => {
    for (const code of [
      'SOURCE_UNAVAILABLE',
      'SOURCE_HASH_MISMATCH',
      'SOURCE_JOB_FENCED',
      'SOURCE_AUTHORITY_CHANGED',
    ]) {
      const error = new ConvexError({ code, message: 'synthetic domain failure' }),
        { io } = convexSourceTransport(
          {
            runMutation: async () => {
              throw error;
            },
          },
          { projectId: 'project', jobId: 'job', step: 0 },
        );
      await assert.rejects(
        io[method](['a'.repeat(64)]),
        value => value instanceof ForgeError && value.code === code,
      );
    }
    for (const error of [
      new ConvexError({ unexpected: 'platform error' }),
      new ConvexError({ code: 'EXCHANGE_REQUEST_TIMEOUT', message: 'synthetic timeout' }),
      Error('unknown RPC failure'),
    ]) {
      const { io } = convexSourceTransport(
        {
          runMutation: async () => {
            throw error;
          },
        },
        { projectId: 'project', jobId: 'job', step: 0 },
      );
      await assert.rejects(io[method](['a'.repeat(64)]), value => value instanceof SourceIoError);
    }
  });
