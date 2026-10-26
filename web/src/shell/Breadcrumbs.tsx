// SPDX-License-Identifier: Apache-2.0
import './breadcrumbs.css';
import { Fragment } from 'react';
import { cleanUrl, routeUrlState } from './location';
export function workHref(extra: Record<string, string> = {}) {
  const url = routeUrlState();
  const hosted = url.searchParams.has('project');
  for (const key of [
    'intent',
    'lane',
    'viewId',
    'review',
    'reviewView',
    'intentTab',
    'file',
    'head',
    'sourceHead',
    'sourceLane',
    'sourceBackup',
    'classic',
    'workPage',
  ])
    url.searchParams.delete(key);
  url.hash = '';
  url.searchParams.set(hosted ? 'projectTab' : 'tab', hosted ? 'intent' : 'intents');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return cleanUrl(url);
}
export function Breadcrumbs({ items }: { items: readonly { label: string; href: string }[] }) {
  const all = [{ label: 'Work', href: workHref() }, ...items];
  return (
    <nav className="fx-crumbs" aria-label="Breadcrumb">
      {all.map((item, index) => (
        <Fragment key={item.href}>
          {index > 0 && <span aria-hidden="true">›</span>}
          <a href={item.href} title={item.label} aria-current={index === all.length - 1 ? 'page' : undefined}>
            {item.label}
          </a>
        </Fragment>
      ))}
    </nav>
  );
}
