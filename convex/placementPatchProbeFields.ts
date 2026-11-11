// SPDX-License-Identifier: Apache-2.0
// Temporary synthetic S0 fixture (886a4694); removed after the billed patch matrix.
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const fields = {
  key: v.string(),
  step: v.number(),
  payload: v.string(),
  k01: v.number(),
  k02: v.number(),
  k03: v.number(),
  k04: v.number(),
  k05: v.number(),
  k06: v.number(),
  k07: v.number(),
  k08: v.number(),
  k09: v.number(),
  k10: v.number(),
  k11: v.number(),
  k12: v.number(),
  k13: v.number(),
  k14: v.number(),
  k15: v.number(),
  k16: v.number(),
  k17: v.number(),
  k18: v.number(),
  k19: v.number(),
  k20: v.number(),
  k21: v.number(),
  k22: v.number(),
  k23: v.number(),
  k24: v.number(),
};
export const placementPatchProbeTables = {
  placementPatchProbe1: defineTable(fields).index('by_key_01', ['key', 'k01']),
  placementPatchProbe9: defineTable(fields)
    .index('by_key_01', ['key', 'k01'])
    .index('by_key_02', ['key', 'k02'])
    .index('by_key_03', ['key', 'k03'])
    .index('by_key_04', ['key', 'k04'])
    .index('by_key_05', ['key', 'k05'])
    .index('by_key_06', ['key', 'k06'])
    .index('by_key_07', ['key', 'k07'])
    .index('by_key_08', ['key', 'k08'])
    .index('by_key_09', ['key', 'k09']),
  placementPatchProbe24: defineTable(fields)
    .index('by_key_01', ['key', 'k01'])
    .index('by_key_02', ['key', 'k02'])
    .index('by_key_03', ['key', 'k03'])
    .index('by_key_04', ['key', 'k04'])
    .index('by_key_05', ['key', 'k05'])
    .index('by_key_06', ['key', 'k06'])
    .index('by_key_07', ['key', 'k07'])
    .index('by_key_08', ['key', 'k08'])
    .index('by_key_09', ['key', 'k09'])
    .index('by_key_10', ['key', 'k10'])
    .index('by_key_11', ['key', 'k11'])
    .index('by_key_12', ['key', 'k12'])
    .index('by_key_13', ['key', 'k13'])
    .index('by_key_14', ['key', 'k14'])
    .index('by_key_15', ['key', 'k15'])
    .index('by_key_16', ['key', 'k16'])
    .index('by_key_17', ['key', 'k17'])
    .index('by_key_18', ['key', 'k18'])
    .index('by_key_19', ['key', 'k19'])
    .index('by_key_20', ['key', 'k20'])
    .index('by_key_21', ['key', 'k21'])
    .index('by_key_22', ['key', 'k22'])
    .index('by_key_23', ['key', 'k23'])
    .index('by_key_24', ['key', 'k24']),
};
