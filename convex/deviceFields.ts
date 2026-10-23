// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const deviceScope = v.union(v.literal('cli'), v.literal('coordination'));
export const credentialFields = {
  owner: v.string(),
  name: v.string(),
  scope: deviceScope,
  credentialId: v.string(),
  tokenHash: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  revoked: v.boolean(),
};
export const credentialDocument = v.object({
  _id: v.id('cliCredentials'),
  _creationTime: v.number(),
  ...credentialFields,
});
export const deviceFields = {
  operationId: v.string(),
  request: v.string(),
  deviceHash: v.string(),
  userHash: v.string(),
  name: v.string(),
  scope: deviceScope,
  expiresAt: v.number(),
  nextPollAt: v.number(),
  state: v.union(v.literal('pending'), v.literal('approved'), v.literal('denied'), v.literal('consumed')),
  owner: v.optional(v.string()),
  credentialId: v.string(),
  issuedAt: v.optional(v.number()),
  redemptionId: v.optional(v.string()),
  decisionId: v.optional(v.string()),
};
export const deviceDocument = v.object({
  _id: v.id('deviceCodes'),
  _creationTime: v.number(),
  ...deviceFields,
});
export const deviceTables = {
  deviceCodes: defineTable(deviceFields)
    .index('by_deviceHash', ['deviceHash'])
    .index('by_userHash', ['userHash'])
    .index('by_operationId', ['operationId']),
  cliCredentials: defineTable(credentialFields)
    .index('by_credentialId', ['credentialId'])
    .index('by_owner', ['owner']),
  deviceAttempts: defineTable({ owner: v.string(), windowAt: v.number(), count: v.number() }).index(
    'by_owner',
    ['owner'],
  ),
};
