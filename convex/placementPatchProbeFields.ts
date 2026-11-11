// SPDX-License-Identifier: Apache-2.0
// Temporary synthetic S0 fixture (886a4694); removed after the billed patch matrix.
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const fields = { key: v.string(), step: v.number(), payload: v.string() };
export const placementPatchProbeTables = {
  placementPatchProbe1: defineTable(fields).index('by_key_01', ['key']),
  placementPatchProbe9: defineTable(fields)
    .index('by_key_01', ['key'])
    .index('by_key_02', ['key'])
    .index('by_key_03', ['key'])
    .index('by_key_04', ['key'])
    .index('by_key_05', ['key'])
    .index('by_key_06', ['key'])
    .index('by_key_07', ['key'])
    .index('by_key_08', ['key'])
    .index('by_key_09', ['key']),
  placementPatchProbe24: defineTable(fields)
    .index('by_key_01', ['key'])
    .index('by_key_02', ['key'])
    .index('by_key_03', ['key'])
    .index('by_key_04', ['key'])
    .index('by_key_05', ['key'])
    .index('by_key_06', ['key'])
    .index('by_key_07', ['key'])
    .index('by_key_08', ['key'])
    .index('by_key_09', ['key'])
    .index('by_key_10', ['key'])
    .index('by_key_11', ['key'])
    .index('by_key_12', ['key'])
    .index('by_key_13', ['key'])
    .index('by_key_14', ['key'])
    .index('by_key_15', ['key'])
    .index('by_key_16', ['key'])
    .index('by_key_17', ['key'])
    .index('by_key_18', ['key'])
    .index('by_key_19', ['key'])
    .index('by_key_20', ['key'])
    .index('by_key_21', ['key'])
    .index('by_key_22', ['key'])
    .index('by_key_23', ['key'])
    .index('by_key_24', ['key']),
};
