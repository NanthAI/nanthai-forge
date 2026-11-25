// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';

/** Only a finished mark pass proves the running-work tally. */
export const verifiedRollupMembership = (
  project: Doc<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) =>
  project.planLaneMarkCoverage?.generationId === generationId && project.planLaneMarkCoverage.cursor === null;
