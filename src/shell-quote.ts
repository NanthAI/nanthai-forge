// SPDX-License-Identifier: Apache-2.0
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
