// SPDX-License-Identifier: Apache-2.0
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { withLandingController } from '../dist/landing-worker-context.js';

/** State-machine tests execute the controller explicitly. Product clients use
 * AgentWorkflow, whose default land only submits the desired state. */
export class ControllerAgentWorkflow extends AgentWorkflow {
  dispatch(command) {
    return command?.action === 'land' && command.wait !== false
      ? withLandingController(() => super.dispatch(command))
      : super.dispatch(command);
  }
}
