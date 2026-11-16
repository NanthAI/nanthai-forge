// SPDX-License-Identifier: Apache-2.0
// Counts the actual diagnostic entry graph, with no application imports in the probe.
import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
const modules = new Set();
registerHooks({
  load(url, context, next) {
    modules.add(url);
    return next(url, context);
  },
});
globalThis.fetch = () => {
  throw new Error('Startup probe attempted network access');
};
process.on('exit', code => {
  const cpu = process.cpuUsage();
  writeSync(
    2,
    `\nFORGE_STARTUP ${JSON.stringify({ code, cpuMs: (cpu.user + cpu.system) / 1000, modules: [...modules].filter(url => url.startsWith('file:')).length, maxRssKiB: process.resourceUsage().maxRSS })}\n`,
  );
});
