// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Who, type WhoProps } from '../ds';
import { whoLinks, type WhoProject } from './who-links';

/** A row's public byline. An unnamed account has no person or project-run address to link. */
export function RecordedWho({
  handle,
  model,
  project,
  layout,
  agentAuthored,
}: Pick<WhoProps, 'model' | 'layout'> & {
  handle: string | null;
  project?: WhoProject | undefined;
  agentAuthored?: boolean | undefined;
}) {
  const missingRun = agentAuthored && !handle?.includes('/');
  const label = missingRun ? `${handle?.slice(1) ?? ''}/run not reported` : handle;
  if (!label) return <>not reported</>;
  const links = whoLinks(label, missingRun ? undefined : project);
  return <Who handle={label} model={model} layout={layout} nofor={label.startsWith('/')} {...links} />;
}
