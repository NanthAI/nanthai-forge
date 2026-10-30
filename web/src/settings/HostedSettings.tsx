import { AccountHandle } from './AccountHandle';
import type { GithubSyncBinding, GithubAutoPush } from '../../../src/github-sync-types';
import { useWorkRecords } from '../hosted-work-index';
import { GithubStatus } from './GithubStatus';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import type { AutonomyPolicy, PolicyWrite } from '../../../src/autonomy-policy';
import { useSection } from '../WorkspaceUI';
import { type WorkIndexWorkspace } from '../hosted-work-index';
import { hostedError } from '../snapshot';
import ProjectContributors from '../ProjectContributors';
import { DeviceCredentials } from '../DeviceLogin';
import { useUser } from '@clerk/react';
import { navigate } from '../ui/navigation';
import { settingsHref } from './SettingsLayout';
import { Panel, Button, Avatar } from '../ui/primitives';
import HostedGuidance from './HostedGuidance';
import { Autonomy } from './Autonomy';
import HostedChecks from './HostedChecks';
import { SettingsLayout, type SettingsItem } from './SettingsLayout';
export default function HostedSettings({
  projectId,
  workspace,
  owner,
  initial,
  backups,
  general,
  contributions,
  transfer,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace | null;
  owner: boolean;
  initial: string;
  backups?: ReactNode;
  general?: ReactNode;
  contributions?: ReactNode;
  transfer?: ReactNode;
}) {
  const fallback =
    (
      { sharing: 'general', agents: 'agents', backups: 'backups', settings: 'general' } as Record<
        string,
        string
      >
    )[initial] ?? initial;
  const [section] = useSection(
    'settingsSection',
    [
      'you',
      'general',
      'agents',
      'autonomy',
      'checks',
      'access',
      'backups',
      'appearance',
      'devices',
      'contributions',
      'transfer',
      'github',
    ] as const,
    fallback as 'general',
  );
  const items: SettingsItem[] = [
    { id: 'general', label: 'General', group: 'Project' },
    { id: 'agents', label: 'How agents work', group: 'Project' },
    { id: 'autonomy', label: 'Autonomy', group: 'Project' },
    ...(contributions ? [{ id: 'contributions', label: 'Contributions', group: 'Project' as const }] : []),
    { id: 'checks', label: 'Checks', group: 'Project' },
    { id: 'github', label: 'GitHub', group: 'Project' },
    ...(owner ? [{ id: 'access', label: 'Access', group: 'Admin' as const }] : []),
    ...(transfer || (owner && backups)
      ? [{ id: 'transfer', label: 'Transfer & backups', group: 'Admin' as const }]
      : []),
    { id: 'you', label: 'Profile', group: 'You' },
    { id: 'devices', label: 'Signed-in devices', group: 'You' },
  ];
  const hostedMain = useWorkRecords<{ id: string; channel: string }>(projectId, workspace, 'hostedChannels');
  const autoPush = useWorkRecords<GithubAutoPush>(projectId, workspace, 'githubAutoPush');
  const github = useWorkRecords<GithubSyncBinding & { id: string }>(projectId, workspace, 'githubSync');
  const repositories = useWorkRecords<{ id: string; repository: string }>(
    projectId,
    workspace,
    'githubRepositories',
  );
  const project = useQuery(api.projectWork.state, { projectId });
  const labels = useAction(api.projectPeopleActions.labels);
  const [ownerName, setOwnerName] = useState('');
  useEffect(() => {
    if (!project?.owner) return;
    let current = true;
    void labels({ projectId, actors: [project.owner] })
      .then(result => {
        if (current) setOwnerName(result?.[0]?.displayName ?? '');
      })
      .catch(() => {
        if (current) setOwnerName('');
      });
    return () => {
      current = false;
    };
  }, [projectId, project?.owner, labels]);
  const policy = useQuery(api.projectAutonomy.read, section === 'autonomy' ? { projectId } : 'skip');
  const update = useMutation(api.projectAutonomy.set);
  const save = async (command: PolicyWrite): Promise<AutonomyPolicy> => {
    try {
      return (await update({ projectId, command: JSON.stringify(command) })).policy;
    } catch (e) {
      throw new Error(hostedError(e));
    }
  };
  return (
    <SettingsLayout items={items} section={section}>
      {(section === 'general' || section === 'appearance' || (section === 'access' && !owner)) && (
        <>
          <h1>General</h1>
          {owner && (
            <p className="fx-settings-summary">
              <b>{workspace?.name ?? project?.name ?? 'Project'}</b> ·{' '}
              {project?.visibility === 'public' ? 'Public' : 'Private'}
              {project &&
                ` · created ${new Date(project._creationTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} by ${ownerName || (owner ? 'you' : 'the project owner')}`}
            </p>
          )}
          <Panel title="Project">
            <div className="fx-setting">
              <b>Name</b>
              <span>{workspace?.name ?? project?.name ?? 'Project'}</span>
            </div>
            <div className="fx-setting">
              <b>Owner</b>
              <span>{ownerName || (owner ? 'You' : 'Project owner')}</span>
            </div>
            <div className="fx-setting">
              <b>main</b>
              <span title="Native source changes need the owner machine. Hosted selection may differ.">
                {hostedMain.records.some(channel => channel.channel === 'main')
                  ? 'hosted main selection · source on owner machine'
                  : 'main lives on the owner machine · hosted copy'}
              </span>
            </div>
            <div className="fx-setting">
              <b>Visibility</b>
              <span>{project?.visibility === 'public' ? 'Public' : 'Private'}</span>
            </div>
            <div className="fx-setting">
              <b>Created</b>
              <span>
                {project
                  ? new Date(project._creationTime).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : '…'}
              </span>
            </div>
          </Panel>
          {owner && general && <div className="fx-settings-existing">{general}</div>}
        </>
      )}
      {section === 'agents' && (
        <>
          <h1>How agents work</h1>
          <HostedGuidance projectId={projectId} />
        </>
      )}
      {section === 'autonomy' &&
        (policy ? (
          <Autonomy policy={policy} editable={owner} save={save} hosted />
        ) : (
          <p role="status">Reading autonomy…</p>
        ))}
      {section === 'checks' && <HostedChecks projectId={projectId} workspace={workspace} owner={owner} />}
      {section === 'access' && owner && (
        <>
          <h1>Access</h1>
          {owner && (
            <Panel title="People">
              <OwnerRow />
              <div className="fx-settings-existing">
                <ProjectContributors projectId={projectId} />
              </div>
            </Panel>
          )}
          <Panel title="Your devices">
            <div className="fx-setting">
              <Button onClick={() => navigate(settingsHref('devices'))}>Manage signed-in devices</Button>
            </div>
          </Panel>
        </>
      )}
      {(section === 'transfer' || section === 'backups') && (
        <>
          <h1>Transfer &amp; backups</h1>
          <div className="fx-transfer">
            {transfer}
            {owner && backups}
          </div>
        </>
      )}
      {section === 'contributions' && (
        <>
          <h1>Contributions</h1>
          <div className="fx-settings-existing">{contributions}</div>
        </>
      )}
      {section === 'github' && (
        <GithubStatus
          binding={github.records[0]}
          autoPush={autoPush.records[0]}
          repository={repositories.records.length === 1 ? repositories.records[0]?.repository : undefined}
        />
      )}
      {section === 'you' && (
        <>
          <h1>You</h1>
          <AccountHandle />
        </>
      )}
      {section === 'devices' && <SignedInDevices />}
    </SettingsLayout>
  );
}
function SignedInDevices() {
  const { user } = useUser();
  return (
    <>
      <h1>Signed-in devices</h1>
      {user && <DeviceCredentials key={user.id} />}
    </>
  );
}

function OwnerRow() {
  const { user } = useUser();
  const account = useQuery(api.urlAccounts.current, {});
  return (
    <div className="fx-check-row">
      <span className="fx-person">
        <Avatar name={user?.fullName || user?.username || 'You'} />
        <span>
          <b>{user?.fullName || user?.username || 'You'}</b>
          {account && <small>@{account.handle}</small>}
        </span>
      </span>
      <span className="fx-muted">Owner</span>
    </div>
  );
}
