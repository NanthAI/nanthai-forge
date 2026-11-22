// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Advance the wall clock for the nightly fixture check. Timers and elapsed time stay real.
const RealDate = Date;
const realNow = RealDate.now;
const offset = 30 * 86_400_000;
const shiftedNow = () => realNow() + offset;

RealDate.now = shiftedNow;
globalThis.Date = new Proxy(RealDate, {
  apply() {
    return new RealDate(shiftedNow()).toString();
  },
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [shiftedNow()], newTarget);
  },
});

// The OS stamps new fixture files in real time. Read those stamps on the same timeline
// as Date, and translate explicit timestamps back on writes so they round-trip.
function shiftStats(stats) {
  if (!stats) return stats;
  for (const field of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const ms = `${field}Ms`;
    const ns = `${field}Ns`;
    if (typeof stats[ms] === 'bigint') {
      stats[ms] += BigInt(offset);
      stats[ns] += BigInt(offset) * 1_000_000n;
    } else stats[ms] += offset;
  }
  return stats;
}

function diskTime(time) {
  if (time instanceof RealDate) return new RealDate(time.getTime() - offset);
  if (typeof time === 'number' && Number.isFinite(time) && time < 0) return time;
  if ((typeof time === 'number' || typeof time === 'string') && Number.isFinite(Number(time))) {
    // Node treats negative numbers as "now", but accepts negative seconds as strings.
    return String(Number(time) - offset / 1000);
  }
  return time;
}

for (const key of ['stat', 'lstat', 'fstat']) {
  const sync = fs[`${key}Sync`];
  const callback = fs[key];
  const promise = fs.promises[key];
  fs[`${key}Sync`] = (...args) => shiftStats(sync(...args));
  fs[key] = (...args) => {
    const done = args.at(-1);
    if (typeof done === 'function') args[args.length - 1] = (error, stats) => done(error, shiftStats(stats));
    return callback(...args);
  };
  if (promise) fs.promises[key] = async (...args) => shiftStats(await promise(...args));
}
for (const key of ['utimes', 'lutimes', 'futimes']) {
  const sync = fs[`${key}Sync`];
  const callback = fs[key];
  const promise = fs.promises[key];
  fs[`${key}Sync`] = (path, atime, mtime) => sync(path, diskTime(atime), diskTime(mtime));
  fs[key] = (path, atime, mtime, done) => callback(path, diskTime(atime), diskTime(mtime), done);
  if (promise) fs.promises[key] = (path, atime, mtime) => promise(path, diskTime(atime), diskTime(mtime));
}
const handle = await fs.promises.open(new URL(import.meta.url));
const fileHandle = Object.getPrototypeOf(handle);
await handle.close();
const handleStat = fileHandle.stat;
const handleUtimes = fileHandle.utimes;
fileHandle.stat = async function (...args) {
  return shiftStats(await handleStat.apply(this, args));
};
fileHandle.utimes = function (atime, mtime) {
  return handleUtimes.call(this, diskTime(atime), diskTime(mtime));
};
syncBuiltinESMExports();
