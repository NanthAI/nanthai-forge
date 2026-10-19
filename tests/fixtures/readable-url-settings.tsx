// SPDX-License-Identifier: Apache-2.0
// Synthetic data around the actual settings control; no hosted connection.
import { createRoot } from 'react-dom/client';
import { AccountHandle } from '../../web/src/settings/AccountHandle';
import { SettingsLayout } from '../../web/src/settings/SettingsLayout';
import { Shell } from '../../web/src/shell/Shell';
import { ToastProvider } from '../../web/src/ui/Toast';
import { installRoutes, projectIdentity } from '../../src/project-routes';
import { handleError } from '../../src/readable-urls';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
projectIdentity('synthetic', 'dino', 'NanthAi Forge', 'nanthai-forge');
installRoutes(true);
Object.assign(globalThis, { __forgeTree: { queries: {
  'urlAccounts:current': () => ({ handle: 'dino' }),
  'urlAccounts:available': ({ handle }: { handle: string }) => handleError(handle) ?? (handle === 'maya' ? 'This handle is already taken.' : null),
} } });
createRoot(document.getElementById('root')!).render(<ToastProvider><Shell hosted accountName="Dino" tabs={[
  { id: 'now', label: 'Now', glyph: 'now' }, { id: 'intents', label: 'Work', glyph: 'intent' },
  { id: 'code', label: 'Code', glyph: 'code' }, { id: 'settings', label: 'Settings', glyph: 'settings' },
]} current="settings" onTab={() => {}} context={<span>NanthAi Forge</span>}><SettingsLayout section="you" items={[
  { id: 'general', label: 'General', group: 'Project' }, { id: 'checks', label: 'Checks', group: 'Project' },
  { id: 'you', label: 'Profile', group: 'You' }, { id: 'appearance', label: 'Appearance', group: 'You' },
]}><h1>You</h1><AccountHandle /></SettingsLayout></Shell></ToastProvider>);
