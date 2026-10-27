// SPDX-License-Identifier: Apache-2.0
import { indexBuildProgressSchema, type IndexBuildProgress } from './work-index-build-progress.js';
export type HostProgress = {
  type: 'host-progress';
  updatedAt: number;
  phase: string;
  elapsedMs: number;
  phaseElapsedMs: number;
  objectsDone: number;
  objectsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  indexBuild?: IndexBuildProgress & { stepsPerSecond: number };
};
export type ProgressSink = (event: HostProgress) => void;
/** Only counters and fixed phase labels cross this boundary; no paths, URLs or credentials. */
export function hostProgress(sink?: ProgressSink) {
  const started = performance.now();
  let phaseStarted = started,
    phase = '',
    objectsDone = 0,
    objectsTotal = 0,
    bytesDone = 0,
    bytesTotal = 0;
  let indexBuild: HostProgress['indexBuild'];
  let baseline: { at: number; done: number; step: number; phase: string; field?: string } | undefined;
  const emit = () => {
    const now = performance.now(),
      seconds = (now - phaseStarted) / 1000;
    const rate = seconds > 0 ? bytesDone / seconds : 0;
    const recordsPerSecond =
      baseline && indexBuild && now > baseline.at
        ? (indexBuild.done - baseline.done) / ((now - baseline.at) / 1000)
        : 0;
    sink?.({
      type: 'host-progress',
      updatedAt: Date.now(),
      phase,
      elapsedMs: now - started,
      phaseElapsedMs: now - phaseStarted,
      objectsDone,
      objectsTotal,
      bytesDone,
      bytesTotal,
      bytesPerSecond: rate,
      etaSeconds: indexBuild
        ? indexBuild.done >= indexBuild.total && indexBuild.total > 0
          ? 0
          : recordsPerSecond > 0
            ? Math.max(0, indexBuild.total - indexBuild.done) / recordsPerSecond
            : null
        : rate > 0
          ? Math.max(0, bytesTotal - bytesDone) / rate
          : null,
      ...(indexBuild ? { indexBuild } : {}),
    });
  };
  return {
    phase(name: string, objects = 0, bytes = 0) {
      phase = name;
      indexBuild = undefined;
      baseline = undefined;
      phaseStarted = performance.now();
      objectsDone = bytesDone = 0;
      objectsTotal = objects;
      bytesTotal = bytes;
      emit();
    },
    advance(objects: number, bytes: number) {
      objectsDone += objects;
      bytesDone += bytes;
      emit();
    },
    index(raw: string) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = indexBuildProgressSchema.safeParse(value);
      if (!parsed.success) return;
      const next = parsed.data,
        now = performance.now();
      if (
        !baseline ||
        baseline.phase !== next.buildPhase ||
        baseline.field !== next.field ||
        (indexBuild && (next.step < indexBuild.step || next.done < indexBuild.done))
      ) {
        baseline = {
          at: now,
          done: next.done,
          step: next.step,
          phase: next.buildPhase,
          ...(next.field ? { field: next.field } : {}),
        };
      }
      indexBuild = {
        ...next,
        stepsPerSecond:
          now > baseline.at ? Math.max(0, next.step - baseline.step) / ((now - baseline.at) / 1000) : 0,
      };
      objectsDone = next.done;
      objectsTotal = next.total;
      emit();
    },
    emit,
  };
}
export function formatHostProgress(event: HostProgress) {
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  if (event.indexBuild) {
    const build = event.indexBuild;
    return `${event.phase}: ${build.buildPhase}${build.field ? `/${build.field}` : ''}, ${build.done}/${build.total} ${build.buildPhase === 'cleanup' ? 'collections' : 'records'}, ${build.step} steps, ${build.stepsPerSecond.toFixed(1)} steps/s, ETA ${event.etaSeconds === null ? 'pending' : `${Math.ceil(event.etaSeconds)}s`}`;
  }
  return `${event.phase}: ${event.objectsDone}/${event.objectsTotal} objects, ${mb(event.bytesDone)}/${mb(event.bytesTotal)} MB, ${mb(event.bytesPerSecond)} MB/s, ETA ${event.etaSeconds === null ? 'pending' : `${Math.ceil(event.etaSeconds)}s`}`;
}
