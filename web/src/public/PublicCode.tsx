// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A public project's code and history for a signed-out visitor (Item 4c164732): the members' Code views, read only, on
// the site's cached public read (convex/publicCode.ts). The views read through VisitorCodeContext, so no read reaches
// Convex and no Lane or Item link appears. Loaded with its route.
import { useMemo } from 'react';
import { CodeScreen, type CodeProps, type CodeRoute } from '../app/code/CodePlace';
import { VisitorCodeContext, type ProjectId, type VisitorHistory } from '../app/code/code-data';
import '../app/code/code.css';

export default function PublicCode({
  route,
  base,
  first,
}: {
  route: CodeRoute;
  base: string;
  first: VisitorHistory;
}) {
  const visitor = useMemo(() => ({ base, first }), [base, first]);
  const props: CodeProps = {
    route,
    projectId: first.project.id as ProjectId,
    projectName: first.project.name,
    mainHead: first.main ?? null,
  };
  return (
    <VisitorCodeContext.Provider value={visitor}>
      <CodeScreen {...props} />
    </VisitorCodeContext.Provider>
  );
}
