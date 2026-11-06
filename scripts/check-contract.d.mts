// SPDX-License-Identifier: Apache-2.0
export const CHECK_CONTRACT_ENV: 'FORGE_CHECK_CONTRACT';
export const CHECK_CONTRACT_PROVIDED: number;
export const CHECK_CONTRACT_REQUIRED: number;
export const CHECK_CONTRACT_SURFACE_DIGEST: string;
export class CheckContractError extends Error {
  readonly code: 'CHECK_CONTRACT_MISMATCH';
}
export function surfaceDigest(surface: unknown): string;
export function assertCheckContract(env?: Record<string, string | undefined>, required?: number): void;
export function declaredRequirement(root?: string): number | undefined;
