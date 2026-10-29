// SPDX-License-Identifier: Apache-2.0
// Actions already masks exact secrets. Also mask the fragments/endpoints derived
// from them before either credential-bearing command runs. Never emit these elsewhere.
export function backupMasks(env) {
  return [
    env.CONVEX_DEPLOY_KEY?.split('|')[0],
    env.R2_ACCOUNT_ID && `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    env.R2_ACCOUNT_ID &&
      env.R2_BUCKET &&
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/`,
  ].filter(Boolean);
}

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const value of backupMasks(process.env))
    console.log(
      `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`,
    );
}
