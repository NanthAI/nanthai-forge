import { Menu } from '../ui/Menu';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useState } from 'react';
export const SourcePinContext = createContext<{ head?: string; backupId?: string }>({});
import { cleanUrl, routeUrlState } from './location';
import { Button, ButtonLink } from '../ui/primitives';
import { settingsHref } from '../settings/SettingsLayout';

/** G1's route codec, with immutable source pins and an exact line anchor. */
export function savedLink(head: string, file?: string, line?: number, sourceOnly = false, backupId?: string) {
  const base = typeof location === 'undefined' ? 'http://local/' : location.href;
  const url = routeUrlState(base);
  url.searchParams.set('head', head);
  const lane = url.searchParams.get('lane') || url.searchParams.get('laneId');
  if (lane) url.searchParams.set('sourceLane', lane);
  if (backupId) url.searchParams.set('sourceBackup', backupId);
  url.searchParams.delete('line');
  url.hash = '';
  if (file || sourceOnly) {
    for (const key of ['intent', 'lane', 'review', 'reviewView', 'viewId', 'laneId'])
      url.searchParams.delete(key);
    url.searchParams.set(
      url.searchParams.has('project') ? 'projectTab' : 'tab',
      url.searchParams.has('project') ? 'delivery' : 'code',
    );
    if (file) url.searchParams.set('file', file);
    else url.searchParams.delete('file');
    url.searchParams.set('view', 'source');
  }
  if (file && line) url.hash = `L${line}`;
  // Startup bearer tokens are private to the browser session, never shared.
  url.searchParams.delete('token');
  return new URL(cleanUrl(url, base), base).href;
}

/** Open Code at an exact save (`head` only sets the Source picker), retaining the Lane label. */
export function codeSourceLink(head: string, laneId?: string, backupId?: string) {
  const url = new URL(savedLink(head, undefined, undefined, true, backupId));
  url.searchParams.delete('sourceHead');
  if (laneId) url.searchParams.set('sourceLane', laneId);
  else url.searchParams.delete('sourceLane');
  return cleanUrl(url);
}

/** Shared on Work objects, saves and files. Transfer keeps its existing Settings destination. */
export function ObjectActions({
  head,
  file,
  line,
  save = false,
  href,
}: {
  head?: string;
  file?: string;
  line?: number;
  save?: boolean;
  href?: string;
}) {
  const pin = useContext(SourcePinContext);
  const linked = routeUrlState().searchParams;
  head = (!save && linked.get('head')) || head || pin.head;
  const backupId = linked.get('sourceBackup') || pin.backupId;
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [head, file, line, href, backupId]);
  if (!head && !href) return null;
  return (
    <div className="fx-object-actions">
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(
              head ? savedLink(head, file, line, save, backupId) : new URL(href!, location.href).href,
            )
            .then(
              () => setMessage('Copied'),
              () => setMessage('Could not copy. Try again.'),
            )
        }
      >
        {message === 'Copied' ? 'Copied' : 'Copy link'}
      </Button>
      {head && (
        <Menu label="Get code" className="fx-btn fx-btn-ghost fx-btn-sm">
          <ButtonLink
            variant="ghost"
            href={codeSourceLink(head, linked.get('lane') ?? linked.get('sourceLane') ?? undefined, backupId)}
          >
            Browse source
          </ButtonLink>
          <ButtonLink
            variant="ghost"
            href={settingsHref(routeUrlState().searchParams.has('project') ? 'transfer' : 'backups')}
          >
            Transfer &amp; backups
          </ButtonLink>
        </Menu>
      )}
      <span className="fx-sr" role="status">
        {message === 'Copied' ? 'Link copied' : ''}
      </span>
      {message && message !== 'Copied' && <ErrorToast>{message}</ErrorToast>}
    </div>
  );
}
