// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { codeFilePattern } from './ecosystems.js';
/** Source-code file names in any common language (src/ecosystems.ts); group 1 is the name without
 * its extension. One list shared by test-name matching, JUnit code labels and by the capture rule
 * that keeps code modules named `credentials.*` or `secrets.*` (`internal/auth/credentials.go`,
 * `src/Secrets.cs`). */
export const codeFileName = codeFilePattern();
