// SPDX-License-Identifier: Apache-2.0
// The docs frame (DESIGN.md rule 47): a left tree and one readable column, without app data or motion.
import type { ReactNode } from 'react';
import { ForgeMark } from '../shell/brand';

export type DocsGroup = { label: string; pages: readonly { title: string; href: string }[] };
export function DocsFrame({
  groups,
  current,
  children,
}: {
  groups: readonly DocsGroup[];
  current: string;
  children: ReactNode;
}) {
  return (
    <div className="docs-shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="pubbar">
        <a className="brand" href="/" translate="no">
          <ForgeMark size={20} motion="still" />
          <span>Forge</span>
        </a>
        <a href="/docs/" aria-current={current === '/docs/' ? 'page' : undefined}>
          Docs
        </a>
        <div className="end">
          <a href="/llms.txt">For agents</a>
          <button className="btn ghost" type="button" data-docs-theme="" aria-label="Switch colour theme">
            Theme
          </button>
        </div>
      </header>
      <div className="docs-layout">
        <aside className="docs-tree">
          <details className="docs-contents" open>
            <summary>Contents</summary>
            <nav aria-label="Documentation">
              <label className="docs-find">
                Find a page
                <input className="inp" type="search" data-docs-find="" placeholder="Search page titles" />
              </label>
              <p className="docs-no-results" hidden role="status">
                No matching pages. Clear the search to see every page.
              </p>
              {groups.map(group => (
                <section key={group.label} data-docs-group="" aria-label={group.label}>
                  <h2>{group.label}</h2>
                  {group.label === 'More documentation' ? (
                    <details>
                      <summary>Browse all pages</summary>
                      <ul>
                        {group.pages.map(page => (
                          <li key={page.href}>
                            <a href={page.href} aria-current={current === page.href ? 'page' : undefined}>
                              {page.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <ul>
                      {group.pages.map(page => (
                        <li key={page.href}>
                          <a href={page.href} aria-current={current === page.href ? 'page' : undefined}>
                            {page.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </nav>
          </details>
        </aside>
        <main id="main" tabIndex={-1}>
          <div className="docs-tools">
            <a href="/docs/">Documentation</a>
            <span> / </span>
            <a href={`${current === '/docs/' ? '/docs/README' : current.slice(0, -1)}.md`}>Markdown</a>
            <span> · </span>
            <a href="/llms-full.txt">Full text for agents</a>
          </div>
          <article className="md">{children}</article>
          <footer className="docs-footer">
            <a href="/docs/quickstart/">Start your first Lane</a>
            <a href="/docs/reference/cli/">CLI reference</a>
            <a href="/docs/reference/mcp/">MCP reference</a>
            <span className="docs-legal">
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy policy</a>
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
