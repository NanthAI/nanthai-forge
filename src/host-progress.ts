// SPDX-License-Identifier: Apache-2.0
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
  const emit = () => {
    const now = performance.now(),
      seconds = (now - phaseStarted) / 1000;
    const rate = seconds > 0 ? bytesDone / seconds : 0;
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
      etaSeconds: rate > 0 ? Math.max(0, bytesTotal - bytesDone) / rate : null,
    });
  };
  return {
    phase(name: string, objects = 0, bytes = 0) {
      phase = name;
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
    emit,
  };
}
export function formatHostProgress(event: HostProgress) {
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  return `${event.phase}: ${event.objectsDone}/${event.objectsTotal} objects, ${mb(event.bytesDone)}/${mb(event.bytesTotal)} MB, ${mb(event.bytesPerSecond)} MB/s, ETA ${event.etaSeconds === null ? 'pending' : `${Math.ceil(event.etaSeconds)}s`}`;
}
