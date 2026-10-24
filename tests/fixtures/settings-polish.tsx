// SPDX-License-Identifier: Apache-2.0
// Actual settings components with synthetic account/project records. No hosted connection.
import { createRoot } from 'react-dom/client';
import { SettingsLayout } from '../../web/src/settings/SettingsLayout';
import { Shell } from '../../web/src/shell/Shell';
import { ToastProvider } from '../../web/src/ui/Toast';
import { Autonomy } from '../../web/src/settings/Autonomy';
import HostedGuidance from '../../web/src/settings/HostedGuidance';
import ProjectContributors from '../../web/src/ProjectContributors';
import ProjectProposals from '../../web/src/ProjectProposals';
import { Panel } from '../../web/src/ui/primitives';
import { policyPreset } from '../../src/autonomy-policy';
import { useSection } from '../../web/src/WorkspaceUI';
import { installRoutes, projectIdentity } from '../../src/project-routes';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/shell/search.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('forge-theme', params.get('theme') ?? 'dark');
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
projectIdentity('synthetic', 'dino', 'NanthAi Forge', 'nanthai-forge');
installRoutes(true);
Object.assign(globalThis, { __forgeTree: { queries: {
  'projectContributors:list': () => params.has('empty') ? [] : [{ id: 'member', contributor: 'maya', at: Date.now() }],
  'projectContributors:pending': () => [{ id: 'invite', email: 'new-person@example.test' }],
  'projectContributors:handles': () => [{ handle: 'maya' }],
  'agentGuidance:read': () => ({ project: 'Keep changes small.', personal: 'Explain the outcome.', projectEditable: true }),
}, pages: { 'projectProposals:list': () => params.has('proposals') ? [{ _id: 'proposal', _creationTime: Date.now() - 3600000, actor: 'maya', status: 'stored', head: 'b'.repeat(64), baseState: 'a'.repeat(64), baseArchiveSha256: 'c'.repeat(64), intentId: 'intent', viewId: 'view', digest: 'd'.repeat(64), size: 512, operationId: 'synthetic-operation', projectId: 'synthetic', baseBackupId: 'backup' }] : [] }, actions: {
  'projectContributorActions:labels': () => [{ contributor: 'maya', label: 'Maya Chen', handle: 'maya' }],
} } });
const projectId = 'synthetic' as never;
function Preview() {
  const [section] = useSection('settingsSection', ['general', 'appearance', 'autonomy', 'agents', 'access', 'contributions'] as const, 'autonomy');
  return <ToastProvider><Shell hosted accountName="Maya Chen" accountHandle="maya" account={<button className="fx-account-signout">Sign out</button>} tabs={[
    { id: 'now', label: 'Now', glyph: 'now' }, { id: 'intents', label: 'Work', glyph: 'intent' },
    { id: 'code', label: 'Code', glyph: 'code' }, { id: 'settings', label: 'Settings', glyph: 'settings' },
  ]} current="settings" onTab={() => {}} context={<span>NanthAi Forge</span>}><SettingsLayout section={section} items={[
    { id: 'general', label: 'General', group: 'Project' }, { id: 'agents', label: 'How agents work', group: 'Project' },
    { id: 'autonomy', label: 'Autonomy', group: 'Project' }, { id: 'contributions', label: 'Contributions', group: 'Project' },
    { id: 'access', label: 'Access', group: 'Admin' }, { id: 'checks', label: 'Checks', group: 'Project' }, { id: 'github', label: 'GitHub', group: 'Project' }, { id: 'transfer', label: 'Transfer & backups', group: 'Admin' }, { id: 'you', label: 'Profile', group: 'You' }, { id: 'devices', label: 'Signed-in devices', group: 'You' },
  ]}>
    {(section === 'general' || section === 'appearance') && <><h1>General</h1><Panel title="Project"><div className="fx-setting">NanthAi Forge</div></Panel></>}
    {section === 'autonomy' && <Autonomy policy={policyPreset('trusted')} save={async () => policyPreset('trusted')} />}
    {section === 'agents' && <><h1>How agents work</h1><HostedGuidance projectId={projectId} /></>}
    {section === 'access' && <><h1>Access</h1><Panel title="People"><div className="fx-settings-existing"><ProjectContributors projectId={projectId} /></div></Panel></>}
    {section === 'contributions' && <><h1>Contributions</h1><ProjectProposals inline accessManager pin={params.has('send') ? { intentId: 'intent', baseBackupId: 'backup' as never, baseArchiveSha256: 'c'.repeat(64), baseState: 'a'.repeat(64) } : undefined} projectId={projectId} projectKey="synthetic" /></>}
  </SettingsLayout></Shell></ToastProvider>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
