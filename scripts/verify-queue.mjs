// SPDX-License-Identifier: Apache-2.0
// Queue commands, not dependency promises, so waiting builds cannot deadlock tests.
export function commandQueue(value) {
  const limit = Number(value);
  if (value !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('FORGE_STATIC_WORKERS must be a positive integer');
  let active = 0;
  const waiting = [];
  function drain() {
    while (waiting.length && (value === undefined || active < limit)) {
      const { task, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }
  return task =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      drain();
    });
}
