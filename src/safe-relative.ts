// SPDX-License-Identifier: Apache-2.0
export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !/[\r\n]/.test(path) &&
    path.split('/').every(p => p !== '..' && p !== '.' && p.length > 0)
  );
}
