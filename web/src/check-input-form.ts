// SPDX-License-Identifier: Apache-2.0
import type { DeclaredInput } from '../../src/work-input-types';

export function checkInputName(input: DeclaredInput): string {
  return input.kind === 'source' ? input.path : input.kind === 'tool' ? input.executable : input.name;
}
export function checkInputFields(inputs: readonly DeclaredInput[]): DeclaredInput[] {
  return inputs.map((input, index) => {
    const value = checkInputName(input);
    if (input.kind === 'source' ? !value.length : !value.trim())
      throw new Error(
        `Input ${index + 1} needs a file, executable or name. Remove it to leave the check undeclared.`,
      );
    if (input.kind === 'source') return { ...input }; // Preserve literal source filenames, including spaces.
    if (input.kind === 'tool') return { ...input, executable: value.trim() };
    if (input.kind === 'environment') return { ...input, name: value.trim() };
    const claimSha256 = input.claimSha256?.trim();
    if (claimSha256 && !/^[0-9a-f]{64}$/.test(claimSha256))
      throw new Error(`Input ${index + 1} needs a 64-character lowercase SHA-256, or an empty digest.`);
    return { kind: input.kind, name: value.trim(), ...(claimSha256 ? { claimSha256 } : {}) };
  });
}
