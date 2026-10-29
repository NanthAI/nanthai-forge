// SPDX-License-Identifier: Apache-2.0
import { GraphQuery } from './graph-query.js';
import { validateArtifact } from './artifact-validation.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { exclusion, safeRelative } from './files.js';
import { isRepositoryDocument, isRepositoryNotice } from './document-paths.js';
import type { GithubRepository, HostedArtifact } from './github.js';

export function hostedQuery(
  artifact: HostedArtifact,
  endpoint: string,
  currentHead: string,
  currentRepository: GithubRepository = artifact.repository,
): unknown {
  const pack = validateArtifact(artifact.pack);
  const content = new Map(Object.entries(artifact.content));
  invariant(
    content.size === pack.source.files.length &&
      pack.source.files.every(
        file => typeof content.get(file.path) === 'string' && digest(content.get(file.path)!) === file.digest,
      ),
    'ARTIFACT_INTEGRITY',
    'Stored source differs from the graph manifest.',
  );
  return queryArtifact(artifact, endpoint, currentHead, currentRepository, pack, content);
}

/** The index builder verified the complete original content. Each selected file
 * is independently verified against the immutable graph manifest on range read. */
export function hostedIndexQuery(
  artifact: HostedArtifact,
  endpoint: string,
  currentHead: string,
  currentRepository: GithubRepository,
) {
  const pack = validateArtifact(artifact.pack),
    content = new Map(Object.entries(artifact.content));
  for (const [path, text] of content)
    invariant(
      pack.source.files.some(file => file.path === path && digest(text) === file.digest),
      'ARTIFACT_INTEGRITY',
      'Stored source differs from the graph manifest.',
    );
  return queryArtifact(artifact, endpoint, currentHead, currentRepository, pack, content);
}
function queryArtifact(
  artifact: HostedArtifact,
  endpoint: string,
  currentHead: string,
  currentRepository: GithubRepository,
  pack: HostedArtifact['pack'],
  content: Map<string, string>,
): unknown {
  const query = new GraphQuery(pack, { root: '', source: pack.source, content });
  query.freshness = currentHead === pack.source.gitHead ? 'current' : 'stale';
  const [name, search] = endpoint.split('?');
  const p = new URLSearchParams(search);
  const state = p.get('state');
  invariant(
    !state || state === pack.source.id,
    'STATE_MISMATCH',
    'This link names a different source state. Load the current state explicitly.',
  );
  const number = (key: string, fallback: number) => {
    const value = p.has(key) ? Number(p.get(key)) : fallback;
    invariant(Number.isSafeInteger(value), 'BAD_ARGUMENT', `${key} must be an integer.`);
    return value;
  };
  const file = p.get('file') ?? '',
    limit = number('limit', 50);
  switch (name) {
    case 'status':
      return {
        ...query.status(),
        currentGitHead: currentHead,
        name: currentRepository.full_name,
        hosted: {
          upstream: currentRepository.html_url,
          visibility: currentRepository.private ? 'private' : 'public',
          license: artifact.repository.license?.spdx_id ?? 'Not specified',
          currentLicense: currentRepository.license?.spdx_id ?? 'Not specified',
          attributionScope: 'import-metadata',
        },
      };
    case 'readme': {
      query.context('', 1);
      if (file) {
        invariant(
          safeRelative(file) && !exclusion(file) && isRepositoryDocument(file),
          'NOT_FOUND',
          'This repository document is unavailable.',
        );
        invariant(
          Object.hasOwn(artifact.documents, file) && typeof artifact.documents[file] === 'string',
          'NOT_FOUND',
          'This document is not retained in the indexed snapshot. README remains available; new documents require an explicit re-index.',
        );
        const text = artifact.documents[file];
        return {
          file,
          text,
          digest: digest(text),
          scope: 'git-revision',
          sourceIdentityIncludesReadme: false,
        };
      }
      const readmeFile = Object.keys(artifact.documents).find(path =>
        /^(README|readme|Readme)\.md$/.test(path),
      );
      const notices = Object.entries(artifact.documents).filter(
        ([path]) => isRepositoryNotice(path) && !/^readme\.md$/i.test(path),
      );
      const noticeText = notices
        .map(([path, text]) => {
          let fence = '~~~~';
          for (const match of text.matchAll(/~+/g))
            if (match[0].length >= fence.length) fence = `${match[0]}~`;
          return `\n\n## ${path}\n\n${fence}\n${text}\n${fence}`;
        })
        .join('');
      return {
        file: readmeFile ?? null,
        text: (readmeFile ? artifact.documents[readmeFile] : '') + noticeText,
        scope: 'git-revision',
        sourceIdentityIncludesReadme: false,
      };
    }
    case 'home': {
      query.context('', 1);
      const text = artifact.documents['.nforge/home.md'];
      return {
        file: typeof text === 'string' ? '.nforge/home.md' : null,
        text: typeof text === 'string' ? text : '',
        digest: typeof text === 'string' ? digest(text) : undefined,
        scope: 'git-revision',
        sourceIdentityIncludesReadme: false,
      };
    }
    case 'graph':
      return query.graph(number('offset', 0), number('edgeOffset', 0), limit);
    case 'files':
      return query.files(p.get('search') ?? '', number('offset', 0), limit);
    case 'context':
      return query.context(p.get('search') ?? '', limit);
    case 'declarations':
      return query.declarations(file, limit);
    case 'imports':
      return query.imports(file, limit);
    case 'impact':
      return query.impact(file, limit);
    case 'inspect':
      return query.inspect(p.get('symbol') ?? '', limit);
    case 'refs':
      return query.references(p.get('symbol') ?? '', limit);
    case 'source':
      return query.source(file, number('start', 1), number('end', 80));
    default:
      invariant(false, 'NOT_FOUND', 'Unknown source query.');
  }
}
