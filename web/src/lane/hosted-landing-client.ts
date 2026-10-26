// SPDX-License-Identifier: Apache-2.0
import type { HostedLandingRequest, HostedLandingState } from '../../../src/hosted-landing';
import type { ComposeRequest } from '../../../src/hosted-compose';
import { validateComposePage, buildComposePages } from '../../../src/hosted-compose';
import { hostedRecordSchema } from '../../../src/hosted-records';
import { savePin } from '../../../src/hosted-save';
import { syncResultSchema } from '../../../src/hosted-sync';
import type { HostedMainV2 } from '../../../src/hosted-main';
import { invariant } from '../../../src/errors';
export type Pin = { sha256: string; size: number };
export type LandingIO = {
  query: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
  mutation: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
  read: (pin: Pin) => Promise<unknown>;
  upload: (value: unknown) => Promise<void>;
  wait: <T>(name: string, args: Record<string, unknown>, done: (value: T) => boolean) => Promise<T>;
};
/** Retain all discovery before mutation. A lost reply replays the same request. */
export class BrowserLanding {
  private requests = new Map<string, Promise<HostedLandingRequest>>();
  private reverts = new Map<string, Promise<{ candidateId: string; submission: HostedLandingState }>>();
  constructor(readonly io: LandingIO) {}
  private async manifest(root: Pin) {
    let next: Pin | null = root,
      pages = 0,
      count = 0;
    const seen = new Set<string>();
    while (next) {
      invariant(!seen.has(next.sha256), 'SOURCE_HASH_MISMATCH', 'Composition page cycle.');
      seen.add(next.sha256);
      const value = await this.io.read(next),
        page = validateComposePage(value);
      invariant(
        JSON.stringify(savePin(value)) === JSON.stringify(next),
        'SOURCE_HASH_MISMATCH',
        'Composition page differs from its pin.',
      );
      count += page.entries.length;
      pages++;
      next = page.next;
    }
    return { root, pages, count };
  }
  async accept(operationId: string, candidateId: string, runId?: string) {
    if (!this.requests.has(operationId)) {
      const prepared = (async () => {
        const candidate = hostedRecordSchema.options[3].parse(
          await this.io.query('projectHostedCompose:candidate', { candidateId }),
        );
        const main = await this.io.query<HostedMainV2>('projectHostedChannels:current', {});
        const source: ComposeRequest = {
          operationId,
          intentId: candidate.intentId,
          authorityEpoch: main.authority.epoch,
          expectedMain: candidate.base,
          inputs: await this.manifest(candidate.inputs),
          dependencies: await this.manifest(candidate.dependencies),
          message: 'Accept reviewed Candidate',
        };
        return {
          operationId,
          authorityEpoch: main.authority.epoch,
          channel: 'main' as const,
          expectedMain: candidate.base,
          candidateId,
          expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
          agent: false,
          check: runId ? { kind: 'run' as const, runId } : null,
          finish: { reviewedSource: source, after: null },
        };
      })();
      this.requests.set(operationId, prepared);
      // No mutation happened if discovery fails. A retry may repeat those reads.
      void prepared.catch(() => this.requests.delete(operationId));
    }
    const request = await this.requests.get(operationId)!;
    return this.io.mutation<HostedLandingState>('projectHostedLanding:enqueue', {
      request: JSON.stringify(request),
    });
  }
  retry(
    operationId: string,
    submission: HostedLandingState,
    check: import('../../../src/hosted-landing').HostedLandingAttempt['check'],
  ) {
    const request: HostedLandingRequest = {
      ...submission.request,
      operationId,
      check: check
        ? {
            kind: 'request',
            checkId: check.checkId,
            expectedDefinition: check.definition,
            expectedConfiguration: check.configuration,
            expectedEnvironment: check.environment,
          }
        : null,
    };
    return this.io.mutation<HostedLandingState>('projectHostedLanding:enqueue', {
      request: JSON.stringify(request),
    });
  }
  cancel(operationId: string, submission: HostedLandingState) {
    return this.io.mutation('projectHostedLanding:cancel', {
      request: JSON.stringify({
        operationId,
        authorityEpoch: submission.request.authorityEpoch,
        submissionId: submission.id,
      }),
    });
  }
  /** Fixed source jobs do the reverse and composition. Subscriptions, never timers. */
  async revert(operationId: string, receiptId: string, why: string) {
    // Discovery and compound IDs stay fixed on retry, including unknown enqueue replies.
    const retained = this.reverts.get(operationId);
    if (retained) return retained;
    const result = this.prepareRevert(operationId, receiptId, why);
    this.reverts.set(operationId, result);
    // Source APIs reconcile original UUIDs; retain intermediate selections below.
    void result.catch(() => this.reverts.delete(operationId));
    return result;
  }
  private revertPins = new Map<string, { epoch: number; sync: unknown; compose: string; land: string }>();
  private async source(
    kind: 'Sync' | 'Compose',
    operationId: string,
    request: unknown,
    pages: { kind: string; index: number; value: unknown }[] = [],
  ) {
    const prepared = await this.io.mutation<{ terminal?: unknown }>(`projectHosted${kind}:prepare`, {
      request: JSON.stringify(request),
    });
    if (prepared.terminal) return prepared.terminal;
    for (const page of pages) {
      await this.io.upload(page.value);
      await this.io.mutation(`projectHosted${kind}:stage`, {
        operationId,
        kind: page.kind,
        index: page.index,
        page: JSON.stringify(page.value),
      });
    }
    const progress = await this.io.query<{ input: unknown; terminal: unknown }>(
      `projectHosted${kind}:progress`,
      { operationId },
    );
    if (progress.terminal) return progress.terminal;
    await this.io.upload(progress.input);
    await this.io.mutation(`projectHosted${kind}Jobs:submit`, { operationId });
    return (
      await this.io.wait<{ terminal: unknown }>(`projectHosted${kind}:progress`, { operationId }, value =>
        Boolean(value.terminal),
      )
    ).terminal;
  }
  private compositions = new Map<
    string,
    { request: ComposeRequest; pages: { kind: string; index: number; value: unknown }[] }
  >();
  private async prepareRevert(operationId: string, receiptId: string, why: string) {
    if (!this.revertPins.has(operationId)) {
      const main = await this.io.query<HostedMainV2>('projectHostedChannels:current', {});
      this.revertPins.set(operationId, {
        epoch: main.authority.epoch,
        sync: {
          kind: 'revert',
          operationId,
          authorityEpoch: main.authority.epoch,
          target: { kind: 'receipt', receiptId },
          message: why,
        },
        compose: crypto.randomUUID(),
        land: crypto.randomUUID(),
      });
    }
    const pins = this.revertPins.get(operationId)!;
    const completed = (await this.source('Sync', operationId, pins.sync)) as {
      outcome: { status: string; result: unknown; error?: { message: string } };
    };
    invariant(
      completed.outcome.status === 'completed',
      'SOURCE_JOB_INVALID',
      completed.outcome.error?.message ?? 'Reverse source did not complete.',
    );
    const reverse = syncResultSchema.parse(completed.outcome.result),
      lane = reverse.lane;
    if (!this.compositions.has(operationId)) {
      const main = await this.io.query<HostedMainV2>('projectHostedChannels:current', {});
      const rows = await this.io.mutation<
        { digest: string; size: number; recipe?: { digest: string; size: number } }[]
      >('projectObjectDownloads:describe', { digests: [lane.head] });
      const row = rows[0]!;
      const a = buildComposePages([
        {
          laneId: lane.laneId,
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
          state: {
            object: { sha256: lane.head, size: row.size },
            recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
          },
        },
      ]);
      const b = buildComposePages([]);
      this.compositions.set(operationId, {
        request: {
          operationId: pins.compose,
          intentId: lane.intentId,
          authorityEpoch: pins.epoch,
          expectedMain: { head: main.head, receiptId: main.receipt.id },
          inputs: a.manifest,
          dependencies: b.manifest,
          message: why,
        },
        pages: [a, b].flatMap((group, i) =>
          group.pages.map((page, index) => ({
            kind: i ? 'dependencies' : 'inputs',
            index,
            value: page.value,
          })),
        ),
      });
    }
    const composed = this.compositions.get(operationId)!;
    const finished = (await this.source(
      'Compose',
      pins.compose,
      composed.request,
      composed.pages,
    )) as typeof completed;
    invariant(
      finished.outcome.status === 'completed',
      'SOURCE_JOB_INVALID',
      finished.outcome.error?.message ?? 'Reverse composition did not complete.',
    );
    const candidate = hostedRecordSchema.options[3].parse(finished.outcome.result);
    // Revert explicitly requests verify; generic person acceptance remains
    // available without a check. Never claim an unchecked reverse was checked.
    const check = await this.check();
    if (!this.requests.has(pins.land))
      this.requests.set(
        pins.land,
        Promise.resolve({
          operationId: pins.land,
          authorityEpoch: pins.epoch,
          channel: 'main',
          expectedMain: candidate.base,
          candidateId: candidate.id,
          expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
          agent: false,
          check,
          revertOf: receiptId,
          finish: { composeOperationId: pins.compose, after: null },
        }),
      );
    return {
      candidateId: candidate.id,
      submission: await this.io.mutation<HostedLandingState>('projectHostedLanding:enqueue', {
        request: JSON.stringify(await this.requests.get(pins.land)),
      }),
    };
  }
  private async check(): Promise<HostedLandingRequest['check']> {
    let cursor: string | null = null;
    do {
      const page: {
        page: { check: { id: string; name: string } }[];
        isDone: boolean;
        continueCursor: string;
      } = await this.io.query('projectHostedCheckDefinitions:list', { cursor });
      const verify = page.page.find(row => row.check.name === 'verify');
      if (verify) {
        const settings = await this.io.query<{
          check: { definition: string };
          configurationDigest: string;
          configuration: { environmentFingerprint: string };
        }>('projectHostedCheckDefinitions:current', { checkId: verify.check.id });
        invariant(
          settings.configuration && settings.configurationDigest,
          'RUNNER_UNAVAILABLE',
          'Configure the verify runner.',
        );
        return {
          kind: 'request',
          checkId: verify.check.id,
          expectedDefinition: settings.check.definition,
          expectedConfiguration: settings.configurationDigest,
          expectedEnvironment: settings.configuration.environmentFingerprint,
        };
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    invariant(false, 'RUNNER_UNAVAILABLE', 'Configure verify before submitting this checked revert.');
  }
}
