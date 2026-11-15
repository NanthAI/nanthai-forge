// SPDX-License-Identifier: Apache-2.0
/** Copyable task context; never contains an account token or secret value. */
export function localAgentPrompt(input: {
  name: string;
  projectId: string;
  backend: string;
  source: string;
  revision: number;
  intent?: { id: string; outcome: string };
  objects: boolean;
}) {
  return [
    `Continue work on Forge project ${JSON.stringify(input.name)} using the forge-agent skill.`,
    `Backend: ${input.backend}`,
    `Project ID: ${input.projectId}`,
    `Source: ${input.source}`,
    `Observed hosted Work revision: ${input.revision}`,
    input.intent
      ? `Selected Intent: ${input.intent.id}\nOutcome: ${input.intent.outcome}`
      : 'Inspect current Intents and select the task before editing.',
    'Use an existing hosted clone for this project when available. Inspect its status and preserve unrelated local work.',
    `For a fresh checkout, run: nforge clone ${JSON.stringify(input.projectId)} NEW_DIRECTORY --deployment ${JSON.stringify(input.backend)}`,
    'Authentication comes from nforge login for this backend or the FORGE_AUTH_TOKEN environment override; never paste it into this prompt, source, logs or request files.',
    'Read repository instructions. Use nforge agent ROOT status and inspect the selected Intent. Work in its own Lane, save changes and run the relevant checks; nforge agent ROOT land --save saves and lands under project policy.',
    'Save and land through the hosted Lane commands. Preserve exact original operation IDs and pins for retries; report conflicts and actual check results. Do not infer authority to accept or publish from this handoff alone.',
  ].join('\n\n');
}
