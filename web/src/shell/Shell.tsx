// SPDX-License-Identifier: Apache-2.0
import { preloadDestination } from '../route-preload';
import { projectNavigationHref } from './location';
import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from '../ui/Glyph';
import { InlineWorkNav, useWorkHeader } from './WorkHeader';
import { AccountMenu } from './AccountMenu';
import { useAttention } from './attention-context';
import { useVisibleDecisions } from './visible-decisions';
import { searchHref } from './search-model';
import { navigate } from '../ui/navigation';
import { ForgeMark } from './brand';
import { concepts } from '../ui/concepts';

export type ShellTab<T extends string = string> = {
  id: T;
  label: string;
  glyph: GlyphName;
  count?: number;
  href?: string;
};

/**
 * The one application frame for local and hosted Forge: brand, context, primary destinations,
 * attention and account. Destinations become a bottom bar on narrow screens.
 */
export function Shell<T extends string>({
  context,
  tabs,
  current,
  onTab,
  actions,
  account,
  accountName,
  accountHandle,
  search,
  hosted = false,
  subbar,
  children,
  label = 'Project',
}: {
  context?: ReactNode;
  tabs: readonly ShellTab<T>[];
  current: T | '';
  onTab: (id: T) => void;
  actions?: ReactNode;
  account?: ReactNode;
  accountName?: string;
  accountHandle?: string;
  search?: ReactNode;
  hosted?: boolean;
  subbar?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  const attention = useAttention();
  const { shown } = useVisibleDecisions(attention?.decisions ?? []);
  const needsHref =
    searchHref(hosted, hosted ? { projectTab: 'overview' } : { tab: 'now' }) + '#fx-needs-title';
  const destinations = (className: string) => (
    <nav className={className} aria-label={label}>
      {tabs.map(tab => (
        <a
          key={tab.id}
          href={tab.href ?? projectNavigationHref(tab.id)}
          title={tab.glyph === 'intent' ? `Intent: ${concepts.intent.explain}` : undefined}
          aria-current={current === tab.id ? 'page' : undefined}
          onPointerEnter={() => preloadDestination(tab.id)}
          onFocus={() => preloadDestination(tab.id)}
          onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onTab(tab.id);
          }}
        >
          <Glyph name={tab.glyph} size={15} />
          <span>{tab.label}</span>
          {(className === 'fx-tabbar' && tab.label === 'Now' && attention
            ? shown.length > 0
            : (tab.count ?? 0) > 0) && (
            <span className="fx-tab-count">
              {className === 'fx-tabbar' && tab.label === 'Now' && attention ? shown.length : tab.count}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
  return (
    <div className="fx fx-app">
      <a className="fx-skip" href="#fx-main">
        Skip to content
      </a>
      <header className="fx-top">
        <a className="fx-brand" href="/" aria-label="NanthAi Forge home">
          <ForgeMark />
          <span>
            <small>NanthAi</small>Forge
          </span>
        </a>
        {context && <div className="fx-context">{context}</div>}
        {destinations('fx-tabs')}
        <div className="fx-top-end">
          {actions}
          {search}
          {attention && (
            <a
              className="fx-needs"
              data-empty={shown.length === 0}
              href={needsHref}
              onClick={event => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                navigate(needsHref);
                requestAnimationFrame(() =>
                  document.getElementById('fx-needs-title')?.scrollIntoView({ block: 'start' }),
                );
              }}
            >
              <b>{shown.length}</b>
              <span>need you</span>
            </a>
          )}
          <AccountMenu
            {...(accountName ? { name: accountName } : {})}
            {...(accountHandle ? { handle: accountHandle } : {})}
            account={account}
          />
        </div>
      </header>
      {subbar && <div className="fx-sub">{subbar}</div>}
      <main className="fx-main" id="fx-main" tabIndex={-1}>
        {children}
      </main>
      {tabs.length > 1 && destinations('fx-tabbar')}
    </div>
  );
}

/** Page heading row used by every primary screen: title, one-line summary and at most two actions. */
export function PageHead({
  title,
  summary,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  const header = useWorkHeader();
  const inline = header && typeof title === 'string' && title.toLowerCase() === header.page;
  return (
    <div className={`fx-page-head${inline ? ' fx fx-work-heading' : ''}`}>
      <div className="fx-page-title">
        {eyebrow && <div className="fx-eyebrow">{eyebrow}</div>}
        <div className="fx-title-row">
          <h1>{inline ? 'Work' : title}</h1>
          {inline && <InlineWorkNav header={header} />}
        </div>
        {summary && <div className="fx-page-summary">{summary}</div>}
      </div>
      {actions && <div className="fx-page-actions">{actions}</div>}
    </div>
  );
}

/** Secondary destinations inside one primary screen (for example Intents · Lanes · Planning). */
export function SubNav<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly { id: T; label: string; glyph?: GlyphName; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <nav className="fx-subnav" aria-label={label}>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          aria-current={value === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.glyph && <Glyph name={item.glyph} size={13} />}
          {item.label}
          {item.count !== undefined && <span className="fx-count">{item.count}</span>}
        </button>
      ))}
    </nav>
  );
}
