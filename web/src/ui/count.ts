// SPDX-License-Identifier: Apache-2.0
export const countLabel = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;
