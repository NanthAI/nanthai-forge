// SPDX-License-Identifier: Apache-2.0
// Local anonymous full-open experiment. Invoke via lane.sh heavy; never a CLI or hosted project.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
const [mode, root, argument, freeze] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (mode === 'prepare') {
  const shape = JSON.parse(readFileSync(argument));
  mkdirSync(join(root, 'objects'), { recursive: true, mode: 0o700 });
  const hashes = []; let bytes = 0;
  for (let i = 0; i < shape.sizes.length; i++) {
    const seed = createHash('sha256').update(`anonymous-${i}`).digest();
    const data = Buffer.alloc(shape.sizes[i]);
    for (let at = 0; at < data.length; at += seed.length) seed.copy(data, at, 0, Math.min(seed.length, data.length-at));
    const blob = hash(data); hashes.push(blob); bytes += data.length;
    writeFileSync(join(root, 'objects', blob), data, { mode: 0o600 });
  }
  const files = shape.groups.flatMap((group, i) => group.map((id,j) => ({
    path: `${shape.dirs?.[i] ? shape.dirs[i]+'/' : ''}f${j}.dat`, blob: hashes[id], mode: 'file',
  }))).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const state = Buffer.from(JSON.stringify({ schema:1, kind:'forge-source-state', parents:[], files, message:'synthetic', at:'2026-01-01T00:00:00Z' }));
  const head = hash(state); writeFileSync(join(root,'objects',head),state,{mode:0o600});
  writeFileSync(join(root,'fixture.json'),JSON.stringify({head,files:files.length,objects:hashes.length,bytes}));
  console.log(JSON.stringify({root,files:files.length,objects:hashes.length,bytes}));
} else if (mode === 'child') {
  const { checkoutHostedLane } = await import(process.env.FORGE_CHECKOUT_MEASURE_MODULE || new URL('../../dist/hosted-lane-checkout.js', import.meta.url).href);
  const fixture = JSON.parse(readFileSync(join(root,'fixture.json')));
  const id = randomUUID(), client = join(argument, id);
  const calls = {select:0,objects:0,downloads:0};
  const selection = {schema:2,projectId:'synthetic',laneId:id,intentId:randomUUID(),head:fixture.head,version:0,sourceVersion:0,lifecycleVersion:0,state:'active',base:{head:fixture.head,receiptId:'base'},authority:{mode:'server',epoch:1}};
  const sample = setInterval(() => process.send?.({rss:process.memoryUsage().rss}),250);
  try {
    const start = performance.now();
    const result = await checkoutHostedLane(client,{url:'https://synthetic.invalid',projectId:'synthetic',laneId:id,operationId:randomUUID()},{
      select:async()=>{calls.select++;return selection;},
      objects:async()=>{calls.objects++;throw Error('network forbidden');},
      downloadToFile:async()=>{calls.downloads++;throw Error('network forbidden');},
    });
    const metric = readFileSync(client+'.forge-metrics.jsonl','utf8').trim().split('\n').map(JSON.parse).find(m=>m.kind==='checkout');
    process.send?.({result:{elapsedMs:performance.now()-start,checkout:metric.checkout,calls,machineObjects:result.machineObjects,downloads:result.downloadedObjects},rss:process.memoryUsage().rss});
  } finally { clearInterval(sample); process.disconnect?.(); }
} else if (mode === 'run') {
  if (freeze && existsSync(freeze)) throw Error('measurement paused: freeze present');
  const stage = mkdtempSync(join(root,'cohort-')), children=[], rss=new Map(); let peakRss=0, interrupted=false;
  const watcher = freeze ? watch(dirname(freeze), () => {
    if (existsSync(freeze)) { interrupted=true; for(const child of children) child.kill('SIGTERM'); }
  }) : null;
  const started=performance.now();
  try {
    const results=await Promise.all(Array.from({length:Number(argument)},()=>new Promise((resolve,reject)=>{
      const runtimeEnv={...process.env,FORGE_OBJECT_CACHE:join(root,'objects'),XDG_CACHE_HOME:join(root,'cache')};
      // Ordinary Node default pool, no experimental thread-pool tuning.
      delete runtimeEnv.UV_THREADPOOL_SIZE;
      const child=fork(import.meta.filename,['child',root,stage],{env:runtimeEnv,execArgv:[],silent:true}); children.push(child);
      let result,err=''; child.stderr.on('data',b=>err+=b);
      child.on('message',m=>{rss.set(child.pid,m.rss);peakRss=Math.max(peakRss,[...rss.values()].reduce((a,b)=>a+b,0));if(m.result)result=m.result;});
      child.on('exit',(code,signal)=>{rss.delete(child.pid);code===0&&result?resolve(result):reject(Error(interrupted?'measurement paused: freeze appeared':`${code}/${signal}: ${err}`));});
    })));
    console.log(JSON.stringify({n:Number(argument),wallMs:performance.now()-started,peakAggregateRssBytes:peakRss,results}));
  } finally {
    watcher?.close();
    await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(c=>new Promise(r=>{c.once('exit',r);c.kill('SIGTERM');})));
    // Cleanup only after every child has settled, outside measured I/O.
    if(!process.env.FORGE_CHECKOUT_MEASURE_KEEP)rmSync(stage,{recursive:true,force:true});
  }
} else throw Error('prepare ROOT SHAPE or run ROOT N [FREEZE]');
