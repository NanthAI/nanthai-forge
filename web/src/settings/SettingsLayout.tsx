// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from 'react';
import { routeUrlState, cleanUrl } from '../shell/location';
import { navigate } from '../ui/navigation';
import './settings.css';
export type SettingsItem = { id: string; label: string; group: 'Project' | 'Admin' | 'You' };
export function SettingsLayout({
  items,
  section,
  children,
}: {
  items: SettingsItem[];
  section: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (section === 'appearance') {
      history.replaceState(history.state, '', settingsHref('general'));
      dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [section]);
  return (
    <div className="fx fx-settings-layout">
      <label className="fx-settings-mobile">
        Settings
        <select
          aria-label="Settings page"
          value={section}
          onChange={event => {
            navigate(settingsHref(event.target.value));
          }}
        >
          {!items.some(item => item.id === section) && (
            <option hidden value={section}>
              {({ autonomy: 'Autonomy', access: 'Access' } as Record<string, string>)[section] ?? section}
            </option>
          )}
          {(['Project', 'Admin', 'You'] as const)
            .filter(group => items.some(item => item.group === group))
            .map(group => (
              <optgroup key={group} label={group}>
                {items
                  .filter(item => item.group === group)
                  .map(item => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </label>
      <nav className="fx-settings-nav" aria-label="Settings">
        {(['Project', 'Admin', 'You'] as const).map(group => (
          <div key={group}>
            {items.some(item => item.group === group) && <h2>{group}</h2>}
            {items
              .filter(item => item.group === group)
              .map(item => (
                <a
                  key={item.id}
                  href={settingsHref(item.id)}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={event => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    )
                      return;
                    event.preventDefault();
                    navigate(settingsHref(item.id));
                  }}
                >
                  {item.label}
                </a>
              ))}
          </div>
        ))}
      </nav>
      <div className="fx-settings-content">{children}</div>
    </div>
  );
}
export function settingsHref(section: string) {
  const url = routeUrlState();
  for (const key of ['intent', 'lane', 'review', 'reviewView', 'viewId', 'workPage', 'intentTab', 'activity'])
    url.searchParams.delete(key);
  url.searchParams.set('settingsSection', section);
  url.searchParams.set(url.searchParams.has('project') ? 'projectTab' : 'tab', 'settings');
  return cleanUrl(url);
}
