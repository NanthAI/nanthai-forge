// SPDX-License-Identifier: Apache-2.0
import type { StoredCoordinationCommand } from './coordination-types.js';

/** A claimed path covers that file or everything under that directory. Advisory only. */
export function normalizeCoordinationPath(path: string) {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}
export function pathsOverlap(a: string, b: string) {
  const x = normalizeCoordinationPath(a),
    y = normalizeCoordinationPath(b);
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}
/** Paths from `mine` that overlap any path in `theirs`. */
export function overlappingPaths(mine: readonly string[], theirs: readonly string[]) {
  return mine.filter(path => theirs.some(other => pathsOverlap(path, other)));
}
/** Intent, Lane, head and paths an event refers to, whatever its kind. */
export type CommandScope = {
  intentId?: string | undefined;
  laneId?: string | undefined;
  head?: string | undefined;
  paths?: string[] | undefined;
};
export function commandScope(command: StoredCoordinationCommand): CommandScope {
  switch (command.kind) {
    case 'activity':
    case 'message':
      return command.context;
    case 'claim':
      return { intentId: command.intentId, laneId: command.laneId, paths: command.paths };
    case 'handoff':
      return { intentId: command.intentId, laneId: command.laneId, head: command.head };
    case 'change':
      return { intentId: command.intentId, laneId: command.laneId, head: command.head, paths: command.paths };
    default:
      return {};
  }
}
export type CoordinationScope = { intentIds: Set<string>; laneIds: Set<string>; paths: string[] };
/** True when an event's Intent, Lane or paths intersect the scope. A missing path list means unknown, not unrelated. */
export function inCoordinationScope(command: StoredCoordinationCommand, scope: CoordinationScope) {
  const value = commandScope(command);
  return (
    (!!value.intentId && scope.intentIds.has(value.intentId)) ||
    (!!value.laneId && scope.laneIds.has(value.laneId)) ||
    (!!value.paths?.length && overlappingPaths(value.paths, scope.paths).length > 0)
  );
}
