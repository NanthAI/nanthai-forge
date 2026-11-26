// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';

/** A short Git branch name. The URL path and the full Git ref use separate encodings. */
export const githubBranchSchema = z
  .string()
  .min(1)
  .refine(
    name =>
      name !== '@' &&
      !name.startsWith('-') &&
      !name.endsWith('.') &&
      !name.includes('..') &&
      !name.includes('@{') &&
      !/[\x00-\x20\x7f~^:?*\[\]\\]/u.test(name) &&
      name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')),
    'Use a Git branch name.',
  );

export const githubBranch = (branch?: string) => branch ?? 'main';
export const githubBranchPath = (branch?: string) =>
  githubBranch(branch).split('/').map(encodeURIComponent).join('/');
