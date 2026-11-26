// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Operator rollout pin for the existing Forge hosted verify definition. Its check
// ID and digest identify the exact approved definition, including in-flight runs.
// New definitions opt in using their own recipe field.
const legacyVerify = {
  id: '3ecda28c-1e01-4daf-bf7b-56fba8b6ec8e',
  definition: '1e44d21954404961eea10fe40365e41d20a4663ce60615f5f4accd380b0c5630',
};

export function optedInDistributionCheck(check: {
  id?: string | undefined;
  definition?: string | undefined;
}) {
  return check.id === legacyVerify.id && check.definition === legacyVerify.definition;
}
