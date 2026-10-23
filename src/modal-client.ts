// SPDX-License-Identifier: Apache-2.0
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { modalCostUsageSchema } from './check-backend.js';
import { modalBridge } from './modal-plan.js';
import type { ModalPlan } from './modal-plan.js';
import { invariant } from './errors.js';

export const modalEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('artifactChunk'),
    index: z.number().int().nonnegative(),
    sourcePath: z.string(),
    offset: z.number().int().nonnegative(),
    base64: z.string(),
  }),
  z.object({
    kind: z.literal('artifactEnd'),
    index: z.number().int().nonnegative(),
    sourcePath: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.literal('artifactUnavailable'),
    index: z.number().int().nonnegative(),
    sourcePath: z.string(),
  }),
  z.object({ kind: z.literal('progress'), message: z.string() }),
  z.object({ kind: z.literal('timing'), file: z.string(), seconds: z.number().positive().finite() }),
  z.object({
    kind: z.literal('execution'),
    executionId: z.string(),
    image: z.string(),
    index: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('log'),
    executionId: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
    line: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('result'),
    pin: z.string(),
    head: z.string(),
    definition: z.string(),
    exitCode: z.number().int(),
    costUsage: modalCostUsageSchema.optional(),
    estimatedCostUsd: z.number().nonnegative().finite(),
    executions: z
      .array(
        z.object({
          executionId: z.string(),
          index: z.number().int().nonnegative(),
          attempt: z.number().int().nonnegative(),
          exitCode: z.number().int().optional(),
          infrastructure: z.enum(['oom', 'sandbox-stopped']).optional(),
          tests: z
            .record(
              z.string(),
              z.object({
                file: z.string(),
                complete: z.boolean(),
                durationMs: z.number().positive().finite().optional().catch(undefined),
                results: z.array(z.object({ name: z.string(), passed: z.boolean() })),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    details: z.string().optional(),
  }),
  z.object({
    kind: z.literal('error'),
    category: z.enum(['auth', 'network', 'billing', 'execution', 'unknown']),
    safeFallback: z.boolean(),
    details: z.string().optional(),
    costUsage: modalCostUsageSchema.optional(),
    estimatedCostUsd: z.number().nonnegative().finite().optional(),
  }),
]);
export type ModalEvent = z.infer<typeof modalEventSchema>;
export type ModalClient = (
  path: string,
  event: (event: ModalEvent) => void,
  driver?: (pid: number) => void,
  credentials?: { MODAL_TOKEN_ID: string; MODAL_TOKEN_SECRET: string },
) => Promise<void>;
export function bindModalResult(plan: ModalPlan, result: Extract<ModalEvent, { kind: 'result' }>) {
  invariant(
    result.pin === plan.pin && result.head === plan.head && result.definition === plan.definition,
    'EVIDENCE_CHANGED',
    'Modal result does not match the pinned source, check, selection and runtime.',
  );
  return result;
}
/** SDK errors/stdout are private transport data; only schema-valid events are returned. */
export const modalClient: ModalClient = (path, event, driver, credentials) =>
  new Promise((resolve, reject) => {
    // Both explicit project token values are mandatory. Never discover owner credentials.
    invariant(
      credentials?.MODAL_TOKEN_ID && credentials.MODAL_TOKEN_SECRET,
      'MODAL_CREDENTIALS_REQUIRED',
      'Configure checks.credentialsRef before starting Modal.',
    );
    const config = join(dirname(path), 'modal-project-config.toml');
    writeFileSync(config, '', { mode: 0o600 });
    const env = {
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...credentials,
      MODAL_CONFIG_PATH: config,
    };
    const child = spawn(
      process.env.FORGE_MODAL_PYTHON ?? join(homedir(), '.local', 'venvs', 'forge-modal', 'bin', 'python'),
      [modalBridge, path],
      { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (child.pid) driver?.(child.pid);
    let pending = '',
      failed = false,
      received = false;
    child.stdout.on('data', bytes => {
      pending += bytes.toString();
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        try {
          const parsed = modalEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) {
            received = true;
            event(parsed.data);
          }
        } catch {
          failed = true;
        }
      }
    });
    child.once('error', () => {
      event({
        kind: 'error',
        category: 'auth',
        safeFallback: !existsSync(join(dirname(path), 'modal-executions.json')),
      });
      resolve();
    });
    child.once('close', () => {
      if (!received) {
        event({
          kind: 'error',
          category: 'auth',
          safeFallback: !existsSync(join(dirname(path), 'modal-executions.json')),
        });
        resolve();
      } else if (failed) reject(new Error('Modal transport interrupted.'));
      else resolve();
    });
  });
