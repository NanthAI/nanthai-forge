// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, type MouseEvent } from 'react';
import { settingsHref } from '../settings/SettingsLayout';
import { routeUrlState } from './location';
import { navigate } from '../ui/navigation';
import { Menu } from '../ui/Menu';
import { ThemePicker } from '../ui/Theme';
export function AccountMenu({
  name = 'Local account',
  handle,
  account,
}: {
  name?: string;
  handle?: string;
  account?: ReactNode;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toLocaleUpperCase();
  function accountDestination(section: 'you' | 'devices') {
    if (routeUrlState().searchParams.has('project')) return settingsHref(section);
    return `/settings?settings=${section === 'you' ? 'you' : 'account'}`;
  }
  function openDestination(event: MouseEvent<HTMLAnchorElement>, section: 'you' | 'devices') {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(accountDestination(section));
  }
  return (
    <Menu
      label={<span className="fx-avatar">{initials || '—'}</span>}
      ariaLabel={`${name} account`}
      className="fx-account-trigger"
    >
      <div className="fx-account-identity">
        <strong>{name}</strong>
        {handle && <span>@{handle}</span>}
      </div>
      {account && (
        <>
          <a href={accountDestination('you')} onClick={event => openDestination(event, 'you')}>
            Profile
          </a>
          <a href={accountDestination('devices')} onClick={event => openDestination(event, 'devices')}>
            Signed-in devices
          </a>
        </>
      )}
      <ThemePicker />
      {account && <div className="fx-account-controls">{account}</div>}
    </Menu>
  );
}
