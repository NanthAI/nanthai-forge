// SPDX-License-Identifier: Apache-2.0
import { validateArtifact } from './artifact-validation.js';
import { graphIdentity, identity } from './hash.js';
import { hostedQuery } from './hosted-query.js';
import { invariant } from './errors.js';
import type { HostedArtifact } from './github.js';
import { AGENT_TOOLS, type AgentTool } from './types.js';
export { AGENT_TOOLS, type AgentTool } from './types.js';

export function agentProjection(artifact: HostedArtifact, paths: string[]): HostedArtifact {
  const original = validateArtifact(artifact.pack),
    allowed = new Set(paths);
  const files = original.source.files.filter(file => allowed.has(file.path));
  invariant(
    allowed.size > 0 && allowed.size === paths.length && files.length === allowed.size,
    'AGENT_SCOPE_INVALID',
    'Select included files from the pinned snapshot.',
  );
  const state = {
    gitHead: original.source.gitHead,
    scope: original.source.scope,
    files,
    inventoryDigest: identity(files.map(file => file.path)),
    policy: original.source.policy,
  };
  const source = { id: identity(state), ...state, excluded: {} };
  const ids = new Map(
    original.nodes
      .filter(node => allowed.has(node.locator.file))
      .map(node => [
        node.id,
        `symbol:${identity([source.id, node.locator.file, node.locator.start.offset, node.kind])}`,
      ]),
  );
  const body = {
    schemaVersion: 1 as const,
    source,
    analysis: {
      ...original.analysis,
      limitations: [
        ...original.analysis.limitations,
        'File-scoped projection of retained analysis. Relationships outside selected files remain unknown; counts describe this projection only.',
      ],
    },
    nodes: original.nodes.filter(node => ids.has(node.id)).map(node => ({ ...node, id: ids.get(node.id)! })),
    imports: original.imports
      .filter(edge => allowed.has(edge.from))
      .map(edge =>
        edge.target && !allowed.has(edge.target)
          ? { ...edge, target: null, resolution: 'unresolved' as const }
          : edge,
      ),
    references: original.references
      .filter(edge => allowed.has(edge.locator.file) && ids.has(edge.target))
      .map(edge => ({ ...edge, target: ids.get(edge.target)! })),
    issues: original.issues.filter(issue => allowed.has(issue.file)),
  };
  // Authoritative selected bytes may themselves mention other files. Never rewrite source to hide those mentions.
  return {
    ...artifact,
    pack: { id: graphIdentity(body), ...body },
    documents: {},
    content: Object.fromEntries(files.map(file => [file.path, artifact.content[file.path]!])),
  };
}

export function agentQuery(
  artifact: HostedArtifact,
  paths: string[],
  endpoint: string,
  currentHead: string | null,
): unknown {
  const scoped = agentProjection(artifact, paths);
  invariant(
    AGENT_TOOLS.includes(endpoint.split('?')[0] as AgentTool),
    'AGENT_TOOL_DENIED',
    'This grant does not allow that tool.',
  );
  const result = hostedQuery(scoped, endpoint, scoped.pack.source.gitHead!);
  return {
    ...(result as object),
    pinned: true,
    upstreamHead: currentHead,
    upstreamFreshness:
      currentHead === null ? 'unknown' : artifact.pack.source.gitHead === currentHead ? 'current' : 'stale',
    originalSourceId: artifact.pack.source.id,
    originalAnalysisId: artifact.pack.id,
  };
}
