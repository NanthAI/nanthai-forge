import './github-status.css';
import { useNow } from '../shell/StatusBar';
import { age } from '../ui/status';
// SPDX-License-Identifier: Apache-2.0
import type { GithubSyncBinding, GithubAutoPush } from '../../../src/github-sync-types';
import { CopyCommand } from './CopyCommand';
import { ExactRecord, Panel } from '../ui/primitives';
export function GithubStatus({
  binding,
  repository,
  autoPush,
}: {
  binding?: GithubSyncBinding;
  repository?: string;
  autoPush?: GithubAutoPush;
}) {
  const now = useNow();
  const recorded = binding?.repository || autoPush?.repository || repository;
  const repo = recorded && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(recorded) ? recorded : undefined;
  const last = binding?.commits[binding.pushed - 1];
  const command = `nforge github-sync . --repo ${repo || 'REPO'}`;
  return (
    <>
      <h1>GitHub</h1>
      <Panel title="Publication">
        <p className="fx-settings-note">
          {repo ? (
            <>
              Publishes to {repo} ·{' '}
              {last ? (
                binding?.pushedAt ? (
                  <>
                    last pushed{' '}
                    <time dateTime={binding.pushedAt} title={new Date(binding.pushedAt).toLocaleString()}>
                      {age(binding.pushedAt, now)} ago
                    </time>
                  </>
                ) : (
                  'last pushed time not recorded'
                )
              ) : (
                'never pushed'
              )}
            </>
          ) : (
            'Not connected to GitHub'
          )}
        </p>
        {autoPush && (
          <p className="fx-settings-note" role="status">
            Automatic main push:{' '}
            {autoPush.status === 'needs-you'
              ? 'Needs you — GitHub diverged; both heads retained'
              : autoPush.status}
            {autoPush.status === 'retrying' && autoPush.nextAttemptAt
              ? ` · next attempt ${new Date(autoPush.nextAttemptAt).toLocaleString()}`
              : ''}
            {autoPush.code ? ` · ${autoPush.code}` : ''}
          </p>
        )}
        {autoPush?.status === 'needs-you' && (
          <ExactRecord
            rows={[
              ['Forge main State', autoPush.state],
              ['Forge Git head', autoPush.localHead ?? 'not projected'],
              ['Expected GitHub head', autoPush.expectedHead ?? 'unknown'],
              ['Current GitHub head', autoPush.remoteHead ?? 'unknown'],
            ]}
          />
        )}
        <div className="fx-setting fx-github-command-row">
          <b>Preview</b>
          <CopyCommand command={`${command} --dry-run`} />
        </div>
        {repo && (
          <div className="fx-setting fx-github-command-row">
            <b>Publish</b>
            <CopyCommand command={`${command} --push`} />
          </div>
        )}
        {last && (
          <ExactRecord
            rows={[
              ['Last synced main', last.state],
              ['Git commit', last.commit],
            ]}
          />
        )}
      </Panel>
    </>
  );
}
