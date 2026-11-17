// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Row } from '../ds';
import { DeviceSettings } from './DeviceSettings';
import type { DeviceSettings as Settings } from './access-contract';
import type { DeviceRequest } from './Device';
import './access.css';
export function DeviceFacts({
  request,
  viewerHandle,
  name,
  setName,
  settings,
  setSettings,
  busy,
}: {
  request: DeviceRequest;
  viewerHandle?: string;
  name?: string;
  setName?: (name: string) => void;
  settings?: Settings;
  setSettings?: (settings: Settings) => void;
  busy: boolean;
}) {
  const device = request.device!;
  const row = (label: string, children: ReactNode) => (
    <Row className="access-ask">
      <span className="k">{label}</span>
      <div className="v">{children}</div>
    </Row>
  );
  return (
    <>
      {row(
        'Acts for',
        <>
          <b>{viewerHandle ? `@${viewerHandle}` : 'You'}, for every agent on this device</b>
          <span className="sub">Device settings can narrow your access; they cannot grant more.</span>
        </>,
      )}
      {row(
        'Device',
        <>
          <span className="dcode">{device.code}</span>
          <span className="sub">
            {device.known
              ? `Approved ${device.approvedAt ? new Date(device.approvedAt).toLocaleDateString() : 'earlier'}. Its name and settings are kept.`
              : 'New: this device has not asked before. Match this code with the key reference in your terminal.'}
          </span>
        </>,
      )}
      {row(
        'Name',
        device.known || !setName ? (
          <>
            <q dir="auto" translate="no">
              {request.name}
            </q>
            <span className="sub">Only you see the name. It grants nothing.</span>
          </>
        ) : (
          <>
            <input
              className="inp"
              aria-label="Device name"
              autoComplete="off"
              spellCheck={false}
              maxLength={80}
              value={name ?? request.name}
              onChange={event => setName(event.target.value)}
            />
            <span className="sub">
              Suggested by the terminal; Forge cannot verify it. You name a device once and can rename it in
              You. Only you see the name, and it grants nothing.
            </span>
          </>
        ),
      )}
      {settings && setSettings && (
        <DeviceSettings
          value={settings}
          change={setSettings}
          projectName={device.projectName}
          disabled={busy}
          readOnly={device.known}
        />
      )}
      {row(
        'Sign-in',
        <>
          <b>30 days, renewed while the device is in use</b>
          <span className="sub">
            Approval lasts at most twelve months. Approving it again keeps its name and settings.
          </span>
        </>,
      )}
    </>
  );
}
