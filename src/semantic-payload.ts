// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from './hosted-source-operation.js';
import {
  semanticPlanSchema,
  indexedSemanticPlan,
  semanticConflictsSchema,
  indexedSemanticConflicts,
  type SemanticPlan,
} from './intent-semantic-conflict.js';

/** Encode shared test paths before canonical JSON validation. Ordinary records
 * retain their original objects; source, requests and measurements are unchanged. */
export function semanticPayload(value: unknown, validatedPlans = false): string {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) {
      const items = value.map(visit);
      return items.some((item, index) => item !== value[index]) ? items : value;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      return value;
    const object = value as Record<string, unknown>;
    let result = object;
    for (const [key, child] of Object.entries(object)) {
      const encoded =
        key === 'semanticPlan' && child !== undefined && child !== null
          ? indexedSemanticPlan(validatedPlans ? (child as SemanticPlan) : semanticPlanSchema.parse(child))
          : key === 'semanticConflicts' && child !== undefined && child !== null
            ? indexedSemanticConflicts(semanticConflictsSchema.parse(child))
            : visit(child);
      if (encoded !== child) {
        if (result === object) result = { ...object };
        result[key] = encoded;
      }
    }
    return result;
  }
  return canonicalPayload(visit(value), true);
}
