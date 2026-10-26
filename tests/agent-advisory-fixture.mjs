// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { AgentWorkflow as DurableWorkflow } from '../dist/agent-workflow.js';
import { agentResponseAdvisory } from '../dist/agent-response-advisory.js';
import { resolveAgentDefaults } from '../dist/agent-defaults.js';
import { parseAgentAction } from '../dist/agent-action-parse.js';
import { agentAdvisoryTestHooks } from '../dist/agent-advisory-worker.js';

// Advisory unit tests drive completion explicitly. They retain their source,
// notices and delivery assertions without racing detached OS workers. The actual
// durable-return API and CLI are exercised separately in agent-command-return.
agentAdvisoryTestHooks.launch = () => ({ on() {}, unref() {} });
// This fixture presents one response after full analysis. Defer the indexed
// response's delivery accounting until that final response selects its notices.
// Async context keeps concurrent real/fixture calls independent.
const fullResponse = new AsyncLocalStorage();
const deliver = CoordinationJournal.prototype.deliverOverlaps;
CoordinationJournal.prototype.deliverOverlaps = function (laneId, select, operationId) {
  if (fullResponse.getStore()) return select(this.pendingOverlaps(laneId));
  return deliver.call(this, laneId, select, operationId);
};
export class AgentWorkflow extends DurableWorkflow {
  async dispatch(input) {
    const response = await fullResponse.run(['start', 'checkpoint'].includes(input.action), () =>
      super.dispatch(input),
    );
    if (!['start', 'checkpoint'].includes(input.action)) return response;
    const { command } = resolveAgentDefaults(
      this.work.store,
      parseAgentAction({ ...input, ...response.result.resolved }),
    );
    return agentResponseAdvisory(this.work.store, command, response, response.result.resolved);
  }
}
