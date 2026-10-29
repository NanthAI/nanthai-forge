import { sourceAuthority } from './hosted-source-authority.js';
import { readHostState } from './host-binding.js';
import { ensureWorkIndex } from './work-index-client.js';
// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { localBrief } from './agent-brief-local.js';
import { briefInputSchema, type Briefing } from './agent-brief-types.js';
import { renderBriefing } from './agent-brief-render.js';
import { coordinationClient } from './coordination-client.js';
import { ForgeError, invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
/** Explicit optional hosted binding supplies live coordination; credentials stay in the environment. */
export async function agentBrief(store: WorkStore, input: unknown, liveMcp = false): Promise<Briefing> {
  const parsed = briefInputSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Choose a briefing situation and linked records.');
  return store.observing(() => readBrief(store, parsed.data, liveMcp));
}
async function readBrief(store: WorkStore, input: unknown, liveMcp: boolean): Promise<Briefing> {
  const parsed = briefInputSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Choose a briefing situation and linked records.');
  const binding = readHostState(store).binding;
  const serverBinding = binding && sourceAuthority(binding).mode === 'server' ? binding : undefined;
  const deployment = process.env.FORGE_DEPLOYMENT ?? serverBinding?.deployment,
    projectId = process.env.FORGE_PROJECT_ID ?? serverBinding?.projectId;
  if (!deployment && !projectId) return localBrief(store, input, liveMcp);
  invariant(
    deployment && projectId,
    'BAD_ARGUMENT',
    'Set both FORGE_DEPLOYMENT and FORGE_PROJECT_ID for hosted briefing context.',
  );
  const client = coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN);
  try {
    const args = { ...parsed.data, projectId };
    const read = () =>
      client.query(makeFunctionReference<'query', typeof args, Briefing>('projectBriefings:brief'), args);
    let hosted: Briefing;
    try {
      hosted = await read();
    } catch (error) {
      if (
        !(
          error instanceof ConvexError &&
          typeof error.data === 'object' &&
          error.data !== null &&
          'code' in error.data &&
          error.data.code === 'WORK_STALE'
        )
      )
        throw error;
      await ensureWorkIndex(client, projectId);
      hosted = await read();
    }
    if (hosted.context.coverage.some(line => line.startsWith('Source paths unavailable'))) {
      await client.action(makeFunctionReference<'action'>('projectBriefingActions:prepare'), { projectId });
      hosted = await read();
    }
    const { context } = hosted;
    const localLane = context.laneId ? store.select('lanes', context.laneId) : undefined;
    if (localLane) {
      const local = localBrief(
        store,
        {
          ...parsed.data,
          situation:
            parsed.data.situation === 'take-handoff' || parsed.data.situation === 'answer-message'
              ? 'continue-lane'
              : parsed.data.situation,
          laneId: localLane.id,
          messageId: undefined,
        },
        liveMcp,
      );
      if (sourceAuthority(readHostState(store).binding ?? {}).mode === 'server') {
        if (context.decisions) local.context.decisions = context.decisions;
        else delete local.context.decisions;
      }
      local.context.guidance = context.guidance;
      local.context.autonomyPolicy = context.autonomyPolicy;
      local.context.claims = context.claims;
      local.context.messages = [...local.context.messages, ...context.messages];
      if (context.messageId) local.context.messageId = context.messageId;
      local.context.coverage = local.context.coverage.filter(c => !c.startsWith('Live claims'));
      local.context.coverage.push(
        ...context.coverage.filter(c => !c.startsWith('Source paths unavailable')),
        `Live coordination from hosted project ${projectId}; source pins are from this local owner.`,
      );
      const briefing = renderBriefing(
        parsed.data,
        local.context,
        store.root,
        new Date().toISOString(),
        {
          projectId,
          deployment,
        },
        local.setup,
      );
      if (local.peers) briefing.peers = local.peers;
      return briefing;
    }
    context.coverage.push(
      `Hosted project ${projectId}, selected checkpoint; connect or exchange this source into ROOT before local edits.`,
    );
    return renderBriefing(
      parsed.data,
      context,
      store.root,
      new Date().toISOString(),
      {
        projectId,
        deployment,
      },
      hosted.setup,
    );
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if (
      error instanceof ConvexError &&
      error.data &&
      typeof error.data === 'object' &&
      'code' in error.data &&
      'message' in error.data
    )
      throw new ForgeError(String(error.data.code), String(error.data.message));
    throw new ForgeError(
      'HOSTED_WORK_REQUEST_FAILED',
      'Hosted briefing context could not be read; no successful result is claimed.',
    );
  }
}
