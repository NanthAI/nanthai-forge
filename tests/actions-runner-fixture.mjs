// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Process-level fake for detached Actions controllers. Every provider write is local.
 * Export Git is synthetic; other local Git uses system Git. Remote URLs are intercepted or refused. */
export function actionsRunnerFixture(directory, options = {}) {
  const bin = join(directory, 'fake-actions-bin');
  mkdirSync(bin, { recursive: true });
  const configPath = join(bin, 'config.json');
  const configure = extra => {
    const temporary = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...options, ...extra }));
    renameSync(temporary, configPath);
  };
  configure({});
  const common = `import fs from 'node:fs';import path from 'node:path';
const directory=${JSON.stringify(directory)}, bin=${JSON.stringify(bin)};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const config=read(${JSON.stringify(configPath)});
const entry=id=>path.join(bin,'run-'+id+'.json');
// Discovery and job requests can overlap in separate controllers. Publish complete records.
const replace=(file,bytes)=>{const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,file);};
const save=(file,value)=>replace(file,JSON.stringify(value));
const numeric=id=>parseInt(id.replaceAll('-','').slice(0,8),16)+1;
const plan=id=>read(path.join(directory,'check-'+id,'modal-plan.json'));
const journal=id=>read(path.join(directory,'check-'+id,'github-actions.json'));
`;
  writeFileSync(
    join(bin, 'git-remote.mjs'),
    `#!${process.execPath}\n${common}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
const urls=args.filter(a=>/^(?:https?|ssh|git):/.test(a));
if(urls.length){
 if(urls.some(u=>!/^https:\\/\\/github.com\\/synthetic\\/checks\\.git$/.test(u)))process.exit(90);
 const ref=args.find(a=>/^refs\\/heads\\/forge-check\\//.test(a))??args.at(-1)?.split(':').at(-1);
 const id=ref?.split('/').at(-1), file=path.join(bin,'ref-'+id);
 if(args.includes('ls-remote')){if(fs.existsSync(file))process.stdout.write(fs.readFileSync(file,'utf8')+'\\t'+ref);}
 else if(args.includes('push')){
  const target=args.at(-1);if(target.startsWith(':'))fs.rmSync(file,{force:true});else replace(file,target.split(':')[0]);
 }else process.exit(91);
}else{
 const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(result.status??1);
}
`,
    { mode: 0o700 },
  );
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
case "$*" in
  *://*) exec ${quote(process.execPath)} ${quote(join(bin, 'git-remote.mjs'))} "$@" ;;
  *${directory}/check-*/modal-source*)
    cat >/dev/null
    case "$*" in
      *hash-object*|*write-tree*|*commit-tree*) printf '%s' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
      *) exit 0 ;;
    esac ;;
  *) exec /usr/bin/git "$@" ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}\n${common}
import net from 'node:net';
const args=process.argv.slice(2), endpoint=args[1], paged=args.includes('--paginate');
if(args[0]!=='api'||!endpoint?.startsWith('repos/synthetic/checks/'))process.exit(92);
const send=value=>console.log(JSON.stringify(paged?[value]:value));
const records=()=>fs.readdirSync(bin).filter(n=>/^run-.*\\.json$/.test(n)).map(n=>read(path.join(bin,n)));
const view=r=>({id:r.id,head_sha:journal(r.runId).commit,display_title:'forge-check/'+r.runId,status:'completed',conclusion:r.failed?'failure':'success',run_attempt:1});
if(endpoint.includes('/branches/')){
 const id=decodeURIComponent(endpoint.split('/branches/')[1]).split('/').at(-1);send({commit:{sha:journal(id).commit}});
}else if(endpoint.endsWith('/dispatches')){
 let body='';for await(const chunk of process.stdin)body+=chunk;
 const id=JSON.parse(body).ref.split('/').at(-1);save(entry(numeric(id)),{id:numeric(id),runId:id});
}else if(endpoint.includes('/runs?')){
 const branch=new URL('https://synthetic.invalid/'+endpoint).searchParams.get('branch');
 send({workflow_runs:records().filter(r=>'forge-check/'+r.runId===branch).map(view)});
}else if(/\\/runs\\/\\d+\\/jobs/.test(endpoint)){
 const id=Number(/\\/runs\\/(\\d+)/.exec(endpoint)[1]),r=read(entry(id)),p=plan(r.runId);
 if(r.failed===undefined){
  if(config.gateFile)while(!fs.existsSync(config.gateFile))await new Promise(r=>setTimeout(r,5));
  if(config.endpoint)await new Promise((resolve,reject)=>net.createConnection(config.endpoint).on('end',resolve).on('error',reject).resume());
  await new Promise(resolve=>setTimeout(resolve,config.delay??0));
  const exists=name=>fs.existsSync(path.join(p.source,name));
  r.failed=!!Function('exists','fs','return ('+(config.failWhen??'false')+')')(exists,fs);save(entry(id),r);
 }
 send({jobs:Array.from({length:p.groups.length+1},(_,i)=>({id:id*100+i,name:i===p.groups.length?'forge-static':'forge-shard-'+i,status:'completed',conclusion:r.failed?'failure':'success',run_attempt:1}))});
}else if(endpoint.endsWith('/timing'))send({});
else if(/\\/jobs\\/\\d+\\/logs$/.test(endpoint))process.stdout.write('synthetic retained check output\\n');
else if(/\\/runs\\/\\d+$/.test(endpoint))send(view(read(entry(Number(endpoint.split('/').at(-1))))));
else if(endpoint.endsWith('/cancel'))send({});
else process.exit(93);
`,
    { mode: 0o700 },
  );
  return { bin, configure };
}
