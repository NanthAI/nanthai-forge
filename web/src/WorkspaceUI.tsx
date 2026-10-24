import { routeSearch, routeUrlState } from './shell/location';
// SPDX-License-Identifier: Apache-2.0
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { AppLoader } from './ui/AppLoader';
import { requestNavigation } from './ui/navigation';
import { Icon, type IconName } from './Icons';
export { Icon, type IconName } from './Icons';
export { DetailPanel, DetailPanel as ActionPanel } from './DetailPanel';
export function PageTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly { id: T; label: string; count?: number; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <nav className="page-tabs" aria-label={label}>
      {items.map(item => (
        <button
          key={item.id}
          aria-current={value === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.icon && <Icon name={item.icon} />}
          {item.label}
          {item.count !== undefined && <span> {item.count}</span>}
        </button>
      ))}
    </nav>
  );
}
export function useSection<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const read = () => {
    const value = new URLSearchParams(typeof location === 'undefined' ? '' : routeSearch()).get(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  };
  const [section, setSection] = useState(read);
  useEffect(() => {
    const pop = () => setSection(read());
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  });
  // Section URLs are presentation state only; source pins and operation identities stay untouched.
  const choose = (value: T) =>
    requestNavigation(() => {
      const url = routeUrlState();
      // Preserve the currently displayed default before a preference change, so Back restores it.
      if (!url.searchParams.has(key)) {
        const previous = new URL(url);
        previous.searchParams.set(key, section);
        history.replaceState(history.state, '', previous);
      }
      url.searchParams.set(key, value);
      if (key === 'projectTab')
        for (const drill of ['intent', 'lane', 'reviewView', 'viewId', 'intentTab', 'activity'])
          url.searchParams.delete(drill);
      if (key === 'projectTab') history.pushState(null, '', url);
      else history.replaceState(history.state, '', url);
      setSection(value);
      dispatchEvent(new PopStateEvent('popstate'));
    });
  return [section, choose] as const;
}

export function useDestination(key: string) {
  const read = () => new URLSearchParams(typeof location === 'undefined' ? '' : routeSearch()).get(key) ?? '';
  const [value, setValue] = useState(read);
  useEffect(() => {
    const pop = () => setValue(read());
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, [key]);
  return [
    value,
    (next: string) =>
      requestNavigation(() => {
        const url = routeUrlState();
        if (next) url.searchParams.set(key, next);
        else url.searchParams.delete(key);
        if (['intentTab', 'itemTab', 'fileFilter', 'workLens', 'intentLayout', 'intentFilter'].includes(key))
          history.replaceState(history.state, '', url);
        else history.pushState(null, '', url);
        setValue(next);
        dispatchEvent(new PopStateEvent('popstate'));
      }),
  ] as const;
}

/** Defer unopened screens while preserving drafts after the first visit. */
export function LazyPage({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited ? (
    <section hidden={!active}>
      <Suspense fallback={<AppLoader />}>{children}</Suspense>
    </section>
  ) : null;
}
