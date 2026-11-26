// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { localPreflightSummary } from './agent-preflight-incomplete.js';
import { digest } from './hash.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { commandLine } from './error-teaching.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { PreflightReceipt } from './preflight-receipt.js';
import type { Failure } from './system-errors.js';

export type PreflightRequest = {
  root: string;
  address: HostedAgentAddress;
  operationId: string;
  command: Record<string, unknown>;
};
type LocalPreflight = ReturnType<typeof localPreflightSummary>;
export type PreflightCompletion = {
  exitCode: number;
  result: {
    status: string;
    laneId?: string;
    head?: string;
    workingTree?: true;
    outcome?: LocalPreflight['outcome'];
    localPreflight?: LocalPreflight;
    failed?: number;
    reason?: string;
    error?: Pick<Failure, 'code' | 'message'>;
    command?: string;
    rerun?: string;
    needs?: { runtime: string; next: string };
  };
};
export type PreflightWorkerReply = { reply?: HostedAgentResponse; error?: Failure };
export type PreflightWorkerMessage =
  | { type: 'progress'; chunk: Buffer }
  | { type: 'result'; output: PreflightWorkerReply };
export const PREFLIGHT_RUNNER = 'preflight-runner';
export const PREFLIGHT_EXECUTOR = 'preflight-executor';
export const PREFLIGHT_COMPLETION = 'preflight-completion';

export function preflightJournal({ root, address, operationId, command }: PreflightRequest) {
  // The preflight message and full plan never go into this journal.
  return new HostedAgentJournal(
    root,
    address,
    'local',
    'preflight',
    { request: digest(canonicalPayload(command)) },
    operationId,
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 500);
export function refusedPreflight(failure: Pick<Failure, 'code' | 'message'>): PreflightCompletion {
  return {
    exitCode: 1,
    result: { status: 'refused', error: { code: failure.code, message: oneLine(failure.message) } },
  };
}

export function interruptedPreflight(): PreflightCompletion {
  return refusedPreflight({
    code: 'INTERNAL_ERROR',
    message: 'The preflight worker ended without a result. Run a new preflight.',
  });
}

export function completedPreflight(
  root: string,
  response: HostedAgentResponse,
  exitCode: number,
  elapsedMs: number,
): PreflightCompletion {
  const result = response.result as {
    laneId?: string;
    head?: string;
    workingTree?: boolean;
    outcome?: LocalPreflight['outcome'];
    failed?: number;
    receipt?: PreflightReceipt;
    plan?: { status?: string; reason?: string };
    status?: string;
    saveOperationId?: string;
  };
  const { laneId, head, workingTree, outcome, failed, receipt, plan, saveOperationId } = result;
  const status =
    outcome ?? plan?.status ?? (saveOperationId ? 'save-settling' : (result.status ?? 'unavailable'));
  const localPreflight = receipt
    ? localPreflightSummary(receipt, false)
    : outcome
      ? { tests: 0, outcome, seconds: Math.round(elapsedMs / 100) / 10, reused: false }
      : undefined;
  const follow = outcome === 'failed' ? 'preflight' : 'land --save';
  const needs = receipt?.incomplete?.needs;
  const finish = receipt?.incomplete?.finish;
  const rerun = receipt?.stoppedRerun;
  const cause =
    receipt?.failure?.excerpt ?? receipt?.static?.find(check => check.outcome === 'failed')?.excerpt;
  const reason = receipt?.environment?.code ?? cause ?? (!receipt ? plan?.reason : undefined);
  const command = saveOperationId
    ? commandLine(['agent', root, 'wait', JSON.stringify({ operationIds: [saveOperationId] })])
    : (finish ??
      needs?.next ??
      receipt?.environment?.next ??
      rerun ??
      (laneId && !workingTree
        ? commandLine(['agent', root, ...follow.split(' '), JSON.stringify({ laneId })])
        : undefined));
  return {
    exitCode,
    result: {
      status,
      ...(laneId ? { laneId } : {}),
      ...(head ? { head } : {}),
      ...(workingTree ? { workingTree: true } : {}),
      ...(outcome ? { outcome, failed: failed ?? 0 } : {}),
      ...(localPreflight ? { localPreflight } : {}),
      ...(reason ? { reason: oneLine(reason) } : {}),
      ...(command ? { command } : {}),
      ...(rerun && rerun !== command ? { rerun } : {}),
      ...(needs ? { needs: { runtime: needs.runtime, next: needs.next } } : {}),
    },
  };
}
