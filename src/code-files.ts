// SPDX-License-Identifier: Apache-2.0
/** Source-code file names in any common language; group 1 is the name without its extension.
 * One list shared by test-name matching and by the capture rule that keeps code modules
 * named `credentials.*` or `secrets.*` (`internal/auth/credentials.go`, `src/Secrets.cs`). */
export const codeFileName =
  /^(.+)\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kts?|swift|cs|php|scala|exs?|dart|c|cc|cpp|h|hpp)$/i;
