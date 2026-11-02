// SPDX-License-Identifier: Apache-2.0
// Six finite full-open cohorts; reserve the existing heavy slots before invoking.
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [root,evidence,freeze]=process.argv.slice(2);
const fixture=JSON.parse(readFileSync(join(root,'fixture.json')));
const logs=mkdtempSync(join(root,'paired-logs-'));
try {
  for(const [n,variant] of [[1,'before'],[1,'after'],[1,'before-hot'],[3,'after'],[3,'before'],[10,'before'],[10,'after']]) {
    if(existsSync(freeze))throw Error('measurement paused: freeze present');
    const runtimeEnv={...process.env,FORGE_CHECKOUT_MEASURE_KEEP:'1'};
    if(variant.startsWith('before'))runtimeEnv.FORGE_CHECKOUT_MEASURE_MODULE=pathToFileURL(join(root,'baseline-open.mjs')).href;
    else delete runtimeEnv.FORGE_CHECKOUT_MEASURE_MODULE;
    const result=spawnSync(process.execPath,['tests/fixtures/measure-checkout-open.mjs','run',root,String(n),freeze],{env:runtimeEnv,encoding:'utf8',maxBuffer:16*1024*1024});
    writeFileSync(join(logs,`${variant}-${n}.log`),result.stdout+result.stderr);
    if(result.status!==0)throw Error(result.stderr||'measurement failed');
    const data=JSON.parse(result.stdout);
    for(const sample of data.results) {
      if(sample.calls.select!==2||sample.calls.objects!==0||sample.calls.downloads!==0||sample.downloads!==0||sample.checkout.files!==fixture.files)throw Error('fixture/call budget differs');
    }
    writeFileSync(join(evidence,`paired-${variant}-n${n}.json`),JSON.stringify(data));
    console.log(JSON.stringify({variant,n,wallMs:data.wallMs,peakAggregateRssBytes:data.peakAggregateRssBytes,maxProcessRssKiB:Math.max(...data.results.map(r=>r.checkout.maxRssKiB)),phaseRangesMs:Object.fromEntries(Object.keys(data.results[0].checkout.phasesMs).map(p=>[p,[Math.min(...data.results.map(r=>r.checkout.phasesMs[p])),Math.max(...data.results.map(r=>r.checkout.phasesMs[p]))]]))}));
  }
}finally{
  // Completed raw JSON is retained above. No inter-cell tree removal or OS tuning.
  rmSync(logs,{recursive:true,force:true});
}
