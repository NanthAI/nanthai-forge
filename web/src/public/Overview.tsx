// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { State } from '../ds';
import { lazy, Suspense } from 'react';
import { hrefFor } from '../app/paths';
import { followLink } from '../app/router';
import type { ProjectPage } from './read';

export const projectCode = (project: ProjectPage['project'], section = 'files', rest = '') =>
  hrefFor({ frame: 'project', handle: project.handle, project: project.slug, place: 'code', section, rest });

const ReadmeMarkdown = lazy(() =>
  import('../ds/markdown').then(({ SafeMarkdown }) => ({ default: SafeMarkdown })),
);

const size = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const stamp = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export function ProjectReadme({ project, overview }: Pick<ProjectPage, 'project' | 'overview'>) {
  const readme = overview?.readme;
  return (
    <section className="doc pp-readme" aria-label="README">
      <div className="ph plain">
        <h2>{readme?.path ?? 'README'}</h2>
        {readme ? (
          <>
            <span className="hint">on main</span>
            <span className="tools">
              <a className="lk" href={projectCode(project, 'files', readme.path)} onClick={followLink}>
                Open in Code
              </a>
            </span>
          </>
        ) : null}
      </div>
      {readme ? (
        <>
          <Suspense
            fallback={
              <p className="quietline" role="status">
                Rendering README…
              </p>
            }
          >
            <ReadmeMarkdown text={readme.text} idPrefix="project-readme" scrollTables />
          </Suspense>
          {readme.truncated ? (
            <div className="pp-cutnote">
              <span>This file is {size.format(readme.bytes / 1024)} KB. This is a preview.</span>
              <a className="lk" href={projectCode(project, 'files', readme.path)} onClick={followLink}>
                Read the rest in Code
              </a>
            </div>
          ) : null}
        </>
      ) : (
        <p className="quietline">
          {overview ? 'No README or .nforge/home.md on main.' : 'The README preview is not available.'}
        </p>
      )}
    </section>
  );
}

export function RecentLandings({ project, overview }: Pick<ProjectPage, 'project' | 'overview'>) {
  return (
    <section aria-label="Recent landings">
      <div className="ph plain">
        <h2>Recent landings</h2>
        <span className="hint">newest first</span>
      </div>
      {overview?.landings.length ? (
        overview.landings.map(row => (
          <a className="row tl pub" key={row.id} href={projectCode(project, '', row.id)} onClick={followLink}>
            <time className="num" dateTime={new Date(row.at).toISOString()}>
              {stamp.format(row.at)}
            </time>
            <span className="ttl" dir="auto">
              {row.message || 'Landing'}
            </span>
            <State word="Done" state="passed">
              Landed
            </State>
          </a>
        ))
      ) : (
        <p className="quietline">
          {overview ? 'No landings recorded yet.' : 'The landing preview is not available.'}
        </p>
      )}
      <div className="pf">
        <a className="lk" href={projectCode(project, '')} onClick={followLink}>
          All landings, in Code › History
        </a>
      </div>
    </section>
  );
}
