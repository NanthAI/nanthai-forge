// SPDX-License-Identifier: Apache-2.0
import { getFunctionName } from 'convex/server';
import { checkArgs } from './convex-args.mjs';
import { moduleUrl } from './convex-module.mjs';

const targets = new Map();
const modules = new Map();
async function checkReference(ref, args) {
  const name = getFunctionName(ref);
  if (!targets.has(name)) {
    const [file, method = 'default'] = name.split(':');
    if (!modules.has(file)) modules.set(file, import(moduleUrl(`../convex/${file}.ts`)));
    targets.set(
      name,
      modules.get(file).then(module => {
        if (!module[method]?.exportArgs) throw new Error(`Unknown Convex function ${name}`);
        return module[method];
      }),
    );
  }
  checkArgs(await targets.get(name), args, name);
}

// Accessors preserve validation when a specialized fixture installs a new fake
// dispatcher or scheduler. Resolve only calls actually made; never execute a job.
export function validateContext(ctx) {
  for (const key of ['runQuery', 'runMutation', 'runAction', 'scheduler']) {
    const initial = ctx[key];
    let current;
    Object.defineProperty(ctx, key, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set(value) {
        if (key === 'scheduler') {
          current = { ...value };
          for (const method of ['runAfter', 'runAt']) {
            if (!value[method]) continue;
            current[method] = async (time, ref, args = {}) => {
              await checkReference(ref, args);
              return value[method](time, ref, args);
            };
          }
        } else {
          current = async (ref, args = {}) => {
            await checkReference(ref, args);
            return value(ref, args);
          };
        }
      },
    });
    if (initial) ctx[key] = initial;
  }
  return ctx;
}
