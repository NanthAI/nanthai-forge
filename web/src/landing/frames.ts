// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public page's one requestAnimationFrame loop. A job returns false to leave the loop; with no jobs left the
// loop stops, so a page at rest schedules nothing.
export type FrameJob = (now: number) => boolean;
const jobs = new Set<FrameJob>();
let raf = 0;
function tick(now: number) {
  raf = 0;
  for (const job of jobs) if (!job(now)) jobs.delete(job);
  if (jobs.size) raf = requestAnimationFrame(tick);
}
export function runFrames(job: FrameJob) {
  jobs.add(job);
  if (!raf) raf = requestAnimationFrame(tick);
}
export function stopFrames(job: FrameJob) {
  jobs.delete(job);
}
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)');
