// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Choosing the project's own CI file as the check that decides a landing (Item 0c9207b8), from the web. It writes the
// same runner setting `configure-runner` does (provider "ci-status"), through the owner's existing setting mutation:
// no placeholder values for a person to copy (the server derives the runtime and environment pins from the CI file),
// a compare-and-swap on the setting the reader saw, and one operation id kept until the server answers.
import type { ConvexReactClient } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { hostedMainV2Schema } from '../../../../src/hosted-main';

const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
/** The server replaces these with pins derived from the CI file when it saves the setting. */
const DERIVED = '0'.repeat(64);

/** A problem with a typed workflow path, in words, or null when the server will accept its shape. */
export function workflowProblem(path: string) {
  if (!path.trim()) return 'Type the workflow file, such as .github/workflows/ci.yml.';
  return WORKFLOW.test(path.trim())
    ? null
    : 'A GitHub Actions workflow lives in .github/workflows/ and ends in .yml or .yaml.';
}

/** The setting request for one CI file. */
export function ciFileRequest(input: {
  operationId: string;
  authorityEpoch: number;
  expected: string | null;
  repository: string;
  workflow: string;
}) {
  return {
    operationId: input.operationId,
    authorityEpoch: input.authorityEpoch,
    expected: input.expected,
    change: {
      kind: 'runner' as const,
      configuration: {
        provider: 'ci-status' as const,
        ci: {
          adapter: 'github-actions' as const,
          repository: input.repository,
          workflow: input.workflow.trim(),
        },
        runtime: DERIVED,
        environmentFingerprint: DERIVED,
      },
    },
  };
}

/** The trigger the CI file needs so its runs cover the branches Forge checks. The first Lane adds it. */
export const triggerLine = `on:\n  push:\n    branches: [main, 'forge/candidates/**']`;

/** Reads the pins at the press (two reads), then writes once. A retry passes the same operation id. */
export async function chooseCiFile(
  client: ConvexReactClient,
  projectId: Id<'hostedProjects'>,
  operationId: string,
  repository: string,
  workflow: string,
) {
  const [mainText, currentText] = await Promise.all([
    client.query(api.projectHostedChannels.current, { projectId }),
    client.query(api.projectHostedCheckDefinitions.current, { projectId, checkId: '' }),
  ]);
  const main = hostedMainV2Schema.parse(JSON.parse(mainText));
  const current = JSON.parse(currentText) as { configurationDigest?: string | null };
  const request = ciFileRequest({
    operationId,
    authorityEpoch: main.authority.epoch,
    expected: current.configurationDigest ?? null,
    repository,
    workflow,
  });
  return JSON.parse(
    await client.mutation(api.projectHostedCheckDefinitions.configure, {
      projectId,
      request: JSON.stringify(request),
    }),
  ) as { rule?: string };
}
