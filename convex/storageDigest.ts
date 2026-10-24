// SPDX-License-Identifier: Apache-2.0
export function storageDigest(value: string) {
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : Array.from(atob(value), byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
// An upload is always created after the row that reserved it, and `_storage`
// pages are newest-first, so a scan for that row's file can stop once a page
// reaches files older than the row. The slack tolerates timestamp granularity.
const SCAN_SLACK_MS = 60_000;
export function scanComplete(page: { isDone: boolean; page: { _creationTime: number }[] }, since?: number) {
  return (
    page.isDone || (since !== undefined && page.page.some(file => file._creationTime < since - SCAN_SLACK_MS))
  );
}
