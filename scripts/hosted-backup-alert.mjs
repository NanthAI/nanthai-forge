// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deliverStallAlert } from '../dist/stall-alerts.js';

export async function main(env = process.env, send) {
  const settings = {
    webhook: 'ntfy',
    email: (env.FORGE_ALERT_EMAIL_TO ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  };
  const run = /^\d+$/.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : null;
  const repository = /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) ? env.GITHUB_REPOSITORY : null;
  const url = run && repository ? `https://github.com/${repository}/actions/runs/${run}` : null;
  const alert = {
    subject: '[Forge] Weekly hosted backup failed',
    text: [
      'The dev hosted backup job failed. Check the log for the last verified backup receipt.',
      url ? `Open the failed run: ${url}` : 'Open the failed Weekly hosted backup run in GitHub Actions.',
      'Next step: follow the named failing sub-step and nextStep in the job log before rerunning.',
      'Index snapshot retries are bounded to three exports with 15s and 45s backoff; no index repair runs automatically.',
    ].join('\n'),
  };
  const results = await deliverStallAlert(alert, settings, env, send);
  const delivered = results.some(
    result => typeof result.status === 'number' && result.status >= 200 && result.status < 300,
  );
  console.log(JSON.stringify({ operation: 'backup-failure-alert', delivered, results }));
  if (!delivered) {
    console.error(
      JSON.stringify({
        error: {
          code: results.length ? 'BACKUP_ALERT_DELIVERY_FAILED' : 'BACKUP_ALERT_NOT_CONFIGURED',
          step: 'backup.alert',
          nextStep: results.length
            ? 'Have the owner check the configured stall-alert channel delivery, then rerun the failed alert job.'
            : 'Have the owner add FORGE_ALERT_WEBHOOK_URL to the GitHub Actions hosted-backup environment, then rerun the failed alert job.',
        },
      }),
    );
    return 1;
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
