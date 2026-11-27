// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Synthetic hosted replies for the History screen's exact-receipt compensation path.
const at = '2026-11-17T09:02:03.000Z';
const head = 'f'.repeat(64);
const receiptId = '22ca439f-b51a-4354-ac2b-73ee10598fb5';
const main = { head, receiptId: 'f10c063d-211e-474d-960a-13672a59907a' };
const authority = { mode: 'server', epoch: 1 };
const intentId = '1a24f98c-9c89-498a-9241-fced01eb34bd';
const reverseLane = 'e1466198-0daa-472b-af5f-0385a2d46af3';
const pin = { sha256: head, size: 1 };
const checkId = 'ec2999b2-cfca-41ed-b506-5ee1990922cc';

export function historyRevertFixture(laneId: string) {
  let selected: unknown = null;
  const record = {
    sequence: 2,
    at,
    title: 'Land the parser fix',
    receiptId,
    item: null,
    goal: null,
    message: null,
    actor: 'sample-owner',
    agent: false,
    agentRun: null,
    model: null,
    laneId,
    read: true,
    automatic: true,
    check: 'passed',
    toMain: 123,
    canRevert: true,
  };
  return {
    page: {
      started: true,
      through: 2,
      newest: 2,
      next: null,
      scanned: 2,
      rows: [
        record,
        {
          ...record,
          sequence: 1,
          title: 'An older landing',
          receiptId: main.receiptId,
          check: null,
          toMain: null,
          canRevert: false,
        },
      ],
    },
    query(name: string) {
      if (name === 'projectHostedChannels:current')
        return { head, receipt: { id: main.receiptId }, authority };
      if (name === 'projectHostedCheckDefinitions:list')
        return { page: [{ check: { id: checkId, name: 'verify' } }], isDone: true };
      if (name === 'projectHostedCheckDefinitions:current')
        return {
          check: { definition: head },
          configurationDigest: head,
          configuration: { environmentFingerprint: head },
        };
      return undefined;
    },
    mutation(name: string, args: { request: string }) {
      if (name === 'projectHostedSync:prepare') {
        const request = JSON.parse(args.request);
        selected = request.target;
        return {
          terminal: {
            outcome: {
              status: 'completed',
              result: {
                schema: 1,
                status: 'merged',
                operationId: request.operationId,
                from: null,
                resolution: null,
                at,
                lane: {
                  schema: 2,
                  projectId: 'p1',
                  laneId: reverseLane,
                  intentId,
                  head,
                  version: 1,
                  sourceVersion: 1,
                  lifecycleVersion: 0,
                  state: 'active',
                  base: main,
                  authority,
                },
              },
            },
          },
        };
      }
      if (name === 'projectObjectDownloads:describe') return [{ digest: head, size: 1 }];
      if (name === 'projectHostedCompose:prepare')
        return {
          terminal: {
            outcome: {
              status: 'completed',
              result: {
                id: '04d3d709-b6a2-4913-a672-4b418da53cb8',
                version: 0,
                at,
                kind: 'candidate',
                intentId,
                base: main,
                inputs: pin,
                dependencies: pin,
                algorithm: 'fixture',
                result: { status: 'clean', head },
              },
            },
          },
        };
      if (name === 'projectHostedLanding:enqueue') {
        Object.assign(window, { historyRevert: { selected, request: JSON.parse(args.request) } });
        return { id: '918e1ddc-583d-461e-93d9-360a41b47bd7' };
      }
      return undefined;
    },
  };
}
