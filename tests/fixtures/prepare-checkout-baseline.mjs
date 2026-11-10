// SPDX-License-Identifier: Apache-2.0
// Instrument one pinned original module for local experiments. Builds no CLI.
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const [official,output]=process.argv.slice(2), pinned=realpathSync(official);
const source=readFileSync(join(pinned,'src/hosted-lane-checkout.ts'),'utf8');
let s=source;
function change(from,to){if(!s.includes(from))throw Error('Original module changed: '+from);s=s.replace(from,to);}
s="import {withCheckoutOpenMetrics} from "+JSON.stringify(pathToFileURL(resolve('dist/checkout-open-metrics.js')).href)+";\n"+s;
change('export async function checkoutHostedLane(', 'async function checkout(');
change('  sharedObjects?: string,\n)', '  sharedObjects: string | undefined,\n  metrics: any,\n)');
change('if (operation.complete) return result(true);','if (operation.complete) { metrics.replayed = true; return result(true); }');
change('await cache.ensure([selection.head]);',"await metrics.measure('cacheVerify', () => cache.ensure([selection.head]));");
change('  await cache.ensure(files.map(file => file.blob));',"  metrics.files = files.length;\n  await metrics.measure('cacheVerify', () => cache.ensure(files.map(file => file.blob)));");
change('    const installed = await withCheckoutMaterialization','    const waiting = performance.now();\n    const installed = await withCheckoutMaterialization');
change('      await stageHostedFiles(stage, cache.objects, files);',"      metrics.phasesMs.slotWait += performance.now() - waiting;\n      await metrics.measure('copyHash', () => stageHostedFiles(stage, cache.objects, files));");
change('const flushed = await Promise.allSettled([',"const flushed = await metrics.measure('durability', () => Promise.allSettled([");
change('        flushHostedCheckoutFiles(stage, files),\n      ]);','        flushHostedCheckoutFiles(stage, files),\n      ]));');
change('return indexInstalledFiles(stage, files);',"return metrics.measureSync('index', () => indexInstalledFiles(stage, files));");
change('    workLocked(lock, () => {\n      operation =',"    metrics.measureSync('publish', () => workLocked(lock, () => {\n      operation =");
change('      if (checkoutPathExists(previous)) rmSync(previous, { recursive: true });\n    });','      if (checkoutPathExists(previous)) rmSync(previous, { recursive: true });\n    }));');
s+=`\nexport async function checkoutHostedLane(root,input,transport,sharedObjects) {\nconst request=hostedLaneCheckoutSchema.parse(input);\nreturn withCheckoutOpenMetrics(resolve(root),request,metrics=>checkout(root,request,transport,sharedObjects,metrics));\n}\n`;
s=s.replace("from 'zod'", 'from '+JSON.stringify(import.meta.resolve('zod')));
s=s.replace(/from '(\.\/[^']+)'/g,(_,relative)=>'from '+JSON.stringify(pathToFileURL(join(pinned,'dist',relative)).href));
writeFileSync(join(output,'baseline-open.mjs'),ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).outputText);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(output,'baseline-module-pins.json'),JSON.stringify({pinned,source:sha(join(pinned,'src/hosted-lane-checkout.ts')),modules:Object.fromEntries(['hosted-checkout-cache','hosted-checkout-files','checkout-materialization','files','checkout-stat-index','state/durability'].map(name=>[name,sha(join(pinned,'dist',name+'.js'))]))}));
console.log('Prepared instrumented baseline checkout module from '+pinned);
