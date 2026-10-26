// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { join } from 'node:path';
import { releaseJson, releaseSave } from './maintainer-release-files.js';
import {
  releaseJournalSchema,
  releaseStageSchema,
  type ReleaseReceipt,
} from './maintainer-release-schema.js';
import { executeReleaseStage, ReleaseChildFailure } from './maintainer-release-stages.js';
import { processIdentity } from './local-process.js';

const input = releaseJson(process.argv[2]!) as { journal: unknown; name: unknown; directory: string };
const journal = releaseJournalSchema.parse(input.journal),
  name = releaseStageSchema.parse(input.name);
const attempt = journal.stages.find(stage => stage.name === name)!.attempts.at(-1)!;
releaseSave(join(input.directory, 'process.json'), processIdentity());
let receipt: ReleaseReceipt;
try {
  const result = await executeReleaseStage(journal, name, input.directory);
  receipt = { attemptId: attempt.id, status: 'succeeded', exitCode: 0, signal: null, result };
} catch (error) {
  receipt = {
    attemptId: attempt.id,
    status: name === 'backend' || name === 'web' ? 'unknown' : 'failed',
    exitCode: error instanceof ReleaseChildFailure ? error.exitCode : 1,
    signal: error instanceof ReleaseChildFailure ? error.signal : null,
    result: {},
    code: error instanceof ForgeError ? error.code : 'RELEASE_STAGE_FAILED',
  };
}
releaseSave(join(input.directory, 'receipt.json'), receipt);
process.exitCode = receipt.status === 'succeeded' ? 0 : 1;
