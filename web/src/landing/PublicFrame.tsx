// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { ForgeMark } from '../shell/brand';
import { ThemeToggle } from '../ui/Theme';
import { GitHubGlyph } from './GitHubGlyph';

/** The signed-out header shares the product mark and authentication control. */
export function PublicFrame({ account, children }: { account?: ReactNode; children: ReactNode }) {
  return (
    <div className="fx fx-public">
      <a className="fx-skip" href="#fx-main">
        Skip to content
      </a>
      <header className="fx-public-top">
        <a className="fx-brand" href="/" aria-label="NanthAi Forge home">
          <ForgeMark arrive />
          <span>
            <small>NanthAi</small>Forge
          </span>
        </a>
        <nav aria-label="Public navigation">
          <a href="https://github.com/nanthai/forge#readme">Docs</a>
          <a href="https://github.com/nanthai/forge/blob/main/docs/status.md">Status</a>
          <a href="https://github.com/nanthai/forge">
            <GitHubGlyph /> GitHub
          </a>
          <ThemeToggle />
          {account}
        </nav>
      </header>
      <main id="fx-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
