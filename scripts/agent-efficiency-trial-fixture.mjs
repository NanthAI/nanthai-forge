// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
export function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}
export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function sourceManifest(root) {
  const files = [];
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      if (['.git', '.forge', '.trial', 'node_modules', 'dist', 'SKILL.md', 'AGENTS.md'].includes(name))
        continue;
      const file = join(path, name),
        s = statSync(file);
      if (s.isDirectory()) walk(file);
      else
        files.push({
          path: relative(root, file),
          sha256: digest(readFileSync(file)),
          mode: s.mode & 0o111 ? 0o755 : 0o644,
        });
    }
  }
  walk(root);
  return files;
}
export function seed(root) {
  const files = {
    'package.json':
      JSON.stringify({
        name: 'forge-agent-evaluation',
        private: true,
        type: 'module',
        scripts: { test: 'node --test tests/core.test.mjs' },
      }) + '\n',
    '.gitignore': '.forge/\n.trial/\nnode_modules/\ndist/\n',
    'src/coupon.ts':
      'export function couponEligible(subtotal: number): boolean { return subtotal > 100; }\nexport function discountAmount(subtotal: number, coupon: string): number { return coupon === "SAVE" && couponEligible(subtotal) ? Math.floor(subtotal * 0.1) : 0; }\n',
    'src/tax.ts':
      'export function taxAmount(subtotal: number, rate: number): number { return Math.floor(subtotal * rate / 100); }\n',
    'src/label.ts':
      'export function displayLabel(value: string | null | undefined): string { return value || "General"; }\n',
    'src/checkout.ts':
      'import { discountAmount } from "./coupon.ts";\nimport { taxAmount } from "./tax.ts";\nimport { displayLabel } from "./label.ts";\nexport function quoteCheckout(input: { subtotal: number; coupon: string; label: string }) { const discount = discountAmount(input.subtotal,input.coupon); return { total: input.subtotal - discount + taxAmount(input.subtotal-discount,10), label: displayLabel(input.label) }; }\n',
    'src/invoice.ts':
      'import { taxAmount } from "./tax.ts";\nimport { displayLabel } from "./label.ts";\nexport function previewInvoice(subtotal: number, label: string | null) { return { total:subtotal + taxAmount(subtotal,7.5), label:displayLabel(label) }; }\n',
    'tests/core.test.mjs':
      'import test from "node:test"; import assert from "node:assert/strict";\nimport {couponEligible,discountAmount} from "../src/coupon.ts"; import {taxAmount} from "../src/tax.ts"; import {displayLabel} from "../src/label.ts";\ntest("ordinary API behavior",()=>{ assert.equal(couponEligible(150),true);assert.equal(couponEligible(99),false);assert.equal(discountAmount(200,"SAVE"),20);assert.equal(discountAmount(200,"OTHER"),0);assert.equal(taxAmount(200,10),20);assert.equal(displayLabel(null),"General");assert.equal(displayLabel("Travel"),"Travel"); });\n',
    'scripts/check.mjs': `import {spawnSync} from 'node:child_process';import {mkdirSync,writeFileSync,readFileSync,readdirSync,statSync} from 'node:fs';import {join,relative} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex'),root=process.cwd(),files=[];function walk(p){for(const n of readdirSync(p).sort()){if(['.git','.forge','.trial','node_modules','dist','AGENTS.md','SKILL.md'].includes(n))continue;const f=join(p,n),s=statSync(f);if(s.isDirectory())walk(f);else files.push({path:relative(root,f),sha256:sha(readFileSync(f)),mode:s.mode&73?493:420});}}walk(root);
const startedAt=new Date().toISOString(),r=spawnSync(process.execPath,['--test',...readdirSync('tests').filter(p=>p.endsWith('.test.mjs')).sort().map(p=>'tests/'+p)],{encoding:'utf8'}),log=(r.stdout??'')+(r.stderr??'');const id=randomUUID(),directory='.trial/checks/'+id;mkdirSync(directory,{recursive:true,mode:448});const receipt={id,files,runtime:process.version,startedAt,endedAt:new Date().toISOString(),exitCode:r.status,logSha256:sha(log)};writeFileSync(directory+'/check.log',log,{flag:'wx',mode:384});writeFileSync(directory+'/check.json',JSON.stringify(receipt),{flag:'wx',mode:384});writeFileSync('.trial/check.log',log,{mode:384});writeFileSync('.trial/check.json',JSON.stringify(receipt),{mode:384});process.stdout.write(log);process.exit(r.status??1);
`,
  };
  for (let i = 0; i < 64; i++)
    files[`src/catalog/item-${String(i).padStart(2, '0')}.ts`] =
      `export function catalogItem${i}(value: number): number { return value + ${i}; }\n`;
  for (const [path, text] of Object.entries(files)) {
    write(join(root, path), text);
    chmodSync(join(root, path), 0o644);
  }
}
export function gradeSource(id, answer) {
  const expected = {
    'investigate-cold-graph': {
      entry: 'src/checkout.ts',
      dependencies: ['src/coupon.ts', 'src/label.ts', 'src/tax.ts'],
      couponEligibleAt100: false,
      labelAtEmpty: 'General',
    },
    'investigate-warm-graph': {
      entry: 'src/invoice.ts',
      dependencies: ['src/label.ts', 'src/tax.ts'],
      taxAt100: 7,
      labelAtNull: 'General',
    },
    'investigate-known-file': {
      eligibleAt99: false,
      eligibleAt100: false,
      eligibleAt101: true,
      discountAt100: 0,
    },
  }[id];
  const fields = Object.keys(expected);
  return {
    passed: fields.every(k => JSON.stringify(answer?.[k]) === JSON.stringify(expected[k])),
    cases: fields.length,
    expected,
  };
}
export async function gradeDelivery(id, root, typescriptPath) {
  let checks = [];
  if (id === 'deliver-coupon-boundary') {
    const m = await import(join(root, 'src/coupon.ts'));
    checks = [
      m.couponEligible(99) === false,
      m.couponEligible(100) === true,
      m.couponEligible(101) === true,
      m.discountAmount(100, 'SAVE') === 10,
      m.discountAmount(99, 'SAVE') === 0,
      m.discountAmount(100, 'OTHER') === 0,
    ];
  }
  if (id === 'deliver-tax-rounding') {
    const m = await import(join(root, 'src/tax.ts'));
    checks = [
      [100, 7.5, 8],
      [101, 7.5, 8],
      [200, 10, 20],
      [0, 10, 0],
      [99, 1, 1],
    ].map(([n, r, e]) => m.taxAmount(n, r) === e);
  }
  if (id === 'deliver-empty-label') {
    const m = await import(join(root, 'src/label.ts'));
    checks = [
      m.displayLabel('') === '',
      m.displayLabel(null) === 'General',
      m.displayLabel(undefined) === 'General',
      m.displayLabel('Travel') === 'Travel',
    ];
  }
  if (id === 'deliver-prior670-portable-path') {
    const ts = (await import(typescriptPath)).default,
      text = readFileSync(join(root, 'src/files.ts'), 'utf8'),
      start = text.indexOf('export function safeRelative('),
      end = text.indexOf('\nexport function exclusion', start);
    const js = ts.transpile(text.slice(start, end).replace('export function', 'function'));
    const { isAbsolute, win32 } = await import('node:path');
    const fn = new Function('isAbsolute', 'win32', js + '\nreturn safeRelative;')(isAbsolute, win32);
    const valid = [
      'a',
      'a.ts',
      '.hidden',
      '.foo.ts',
      'a.b/c.d',
      'dir/file.ts',
      'dir/my file.ts',
      'é/日本語.ts',
      'dashes-a/underscores_b.ts',
      'foo..bar/name',
      'dir/…name.ts',
    ];
    const invalid = [
      '',
      '/a',
      '..',
      '../a',
      'a/..',
      'a/../b',
      '.',
      './a',
      'a/.',
      'a/./b',
      'a//b',
      'a/',
      '/',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\rb',
      'dir/\n.ts',
      'dir/\r.ts',
      '//a',
    ];
    checks = [...valid.map(p => fn(p) === true), ...invalid.map(p => fn(p) === false)];
  }
  return {
    passed: checks.length > 0 && checks.every(Boolean),
    cases: checks.length,
    failed: checks.filter(p => !p).length,
  };
}
