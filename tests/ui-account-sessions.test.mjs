// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_C1_SHOTS;

test('C1 You: browser/session and passkey controls, keyboard, both themes and widths, legal pages without cookies', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-c1-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in and devices · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { YouView } from ${JSON.stringify(join(root, 'web/src/app/YouView.tsx'))};
import { DeviceView } from ${JSON.stringify(join(root, 'web/src/app/Device.tsx'))};
import Legal from ${JSON.stringify(join(root, 'web/src/app/Legal.tsx'))};
import { AccountFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') || 'dark';
const now = 1794873600000;
const data = { sessions: [{ sessionId:'browser-a', creationTime:now-3600000, lastRefreshedAt:now, current:true }, {sessionId:'browser-b',creationTime:now-86400000,lastRefreshedAt:now-7200000,current:false}], passkeys:[{passkeyId:'key-a',name:'Security key',createdAt:now-86400000},{passkeyId:'key-b',name:'Travel key',createdAt:now-86400000}], devices:[{credentialId:'terminal-a',name:'Build laptop',code:'dv-synthetic',approvedAt:now-86400000,settings:{source:'write',projects:{kind:'project',projectId:'synthetic-project'}},scope:'cli',issuedAt:now-86400000,expiresAt:now+86400000,revoked:false},{credentialId:'terminal-b',name:'Integration runner',scope:'coordination',issuedAt:now-86400000,expiresAt:now+86400000,revoked:false}],github:'example-builder',notice:{at:now-3600000,passkeyId:'key-b'},deviceNotice:{at:now-1800000,credentialId:'terminal-a',signInId:'synthetic-approval'},isDone:true,continueCursor:''};
function Fixture(){ const [message,setMessage]=React.useState(''); const actions={leave:()=>setMessage('Signed out'),more:()=>{},acknowledge:()=>setMessage('Notice seen'),acknowledgeDevice:()=>setMessage('Device notice seen'),revoke:(includeDevices)=>setMessage(includeDevices?'Fresh passkey requested with devices':'Fresh passkey requested'),github:()=>setMessage('Fresh GitHub check requested'),add:()=>setMessage('Add passkey requested'),rename:(_id,name)=>setMessage('Passkey renamed '+name),remove:()=>setMessage('Passkey removal requested'),renameDevice:(_id,name)=>setMessage('Device renamed '+name),endDevice:()=>setMessage('Device signed out'),removeDevice:()=>setMessage('Device removed'),configureDevice:(_id,_name,value)=>setMessage('Device settings '+value.source)}; return params.get('page')?.startsWith('device') ? <DeviceFixture/> : params.get('page') ? <Legal page={params.get('page')}/> : <AccountFrame place="devices" back={null} controls={{viewerHandle:'example-builder',onPalette(){},onKeys(){}}}><YouView data={data} handle="example-builder" now={now} busy={false} problem={null} {...actions}/><p role="status">{message}</p></AccountFrame> }
function DeviceFixture(){ const known=params.get('page')==='device-known'; const [name,setName]=React.useState('Build laptop'),[typed,setTyped]=React.useState(''),[settings,setSettings]=React.useState({source:'write',projects:{kind:'project',projectId:'synthetic-project'}}),[message,setMessage]=React.useState(''); const request={name:'Build laptop',scope:'cli',expiresAt:now+480000,state:'pending',device:{id:'synthetic-device',code:'dv-synthetic',known,approvedAt:known?now-86400000:null,settings,projectName:'Synthetic project'}};return <><DeviceView phase={{kind:'review',request}} name={name} setName={setName} settings={settings} setSettings={setSettings} code="ABCDE-FGHJK" setCode={()=>{}} typed={typed} setTyped={setTyped} requireTyped={true} busy={false} problem={null} viewerHandle="example-builder" now={now} submit={event=>event.preventDefault()} decide={approve=>setMessage(approve?'Device approved '+name:'Device denied')} restart={()=>{}}/><p role="status">{message}</p></> }
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      await t.test(
        `${width} ${theme}: no clipping or axe violations; controls retain keyboard access`,
        async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 1000 },
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'forge.test') return route.abort();
            const path = url.pathname.slice(1) || 'fixture.html';
            const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
            if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({
              contentType: file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : file.endsWith('.woff2')
                    ? 'font/woff2'
                    : 'text/html',
              body: readFileSync(file),
            });
          });
          await page.goto('https://forge.test/fixture.html?theme=' + theme);
          await page.getByRole('heading', { name: 'You', exact: true }).waitFor();
          assert.match(await page.locator('.sit').textContent(), /2 browsers.*2 devices/);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
          const axe = await page.evaluate(() =>
            window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
          );
          assert.deepEqual(
            axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
            [],
          );
          if (shots)
            await page.screenshot({
              path: join(shots, 'you-' + width + '-' + theme + '.png'),
              fullPage: true,
            });
          await page.getByRole('button', { name: 'Open device Build laptop' }).click();
          await page.getByRole('button', { name: 'Rename', exact: true }).click();
          await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed device');
          await page.getByRole('button', { name: 'Save the name', exact: true }).press('Enter');
          await page.getByRole('status').filter({ hasText: 'Device renamed Renamed device' }).waitFor();
          await page.getByRole('button', { name: 'Change settings', exact: true }).click();
          const write = page.getByRole('radio', { name: 'May write and land with a check', exact: true });
          await write.focus();
          await page.keyboard.press('ArrowRight');
          assert.equal(
            await page.getByRole('radio', { name: 'Read only', exact: true }).getAttribute('aria-checked'),
            'true',
          );
          await page.getByRole('button', { name: 'Save settings', exact: true }).press('Enter');
          await page.getByRole('status').filter({ hasText: 'Device settings read' }).waitFor();
          await page.getByRole('button', { name: 'Remove this device', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'Device removed' }).waitFor();
          await page.getByRole('checkbox', { name: 'Also sign out all devices', exact: true }).check();
          await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
          await page
            .getByRole('status')
            .filter({ hasText: 'Fresh passkey requested with devices' })
            .waitFor();
          assert.deepEqual(errors, []);
          for (const kind of ['device-new', 'device-known']) {
            await page.goto('https://forge.test/fixture.html?theme=' + theme + '&page=' + kind);
            await page
              .getByRole('heading', {
                name: kind === 'device-new' ? 'Make this device yours?' : 'Sign this device in again?',
                exact: true,
              })
              .waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
            const result = await page.evaluate(() =>
              window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
              }),
            );
            assert.deepEqual(
              result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
              [],
            );
            if (shots)
              await page.screenshot({
                path: join(shots, kind + '-' + width + '-' + theme + '.png'),
                fullPage: true,
              });
            if (kind === 'device-new') {
              const approve = page.getByRole('button', { name: 'Approve this device', exact: true });
              assert.equal(await approve.isDisabled(), true);
              await page.getByRole('textbox', { name: 'Device name', exact: true }).fill('Own chosen name');
              await page.getByRole('radio', { name: 'Every project you can reach', exact: true }).click();
              await page.getByRole('radio', { name: 'Synthetic project only', exact: true }).click();
              await page
                .getByRole('textbox', { name: 'Type the code your terminal shows', exact: true })
                .fill('ABCDE-FGHJK');
              await approve.press('Enter');
              await page.getByRole('status').filter({ hasText: 'Device approved Own chosen name' }).waitFor();
            } else {
              assert.equal(await page.getByRole('radio').count(), 0);
              const approve = page.getByRole('button', { name: 'Sign it in again', exact: true });
              assert.equal(await approve.isDisabled(), true);
              await page
                .getByRole('textbox', { name: 'Type the code your terminal shows', exact: true })
                .fill('ABCDE-FGHJK');
              await approve.press('Enter');
              await page.getByRole('status').filter({ hasText: 'Device approved Build laptop' }).waitFor();
            }
          }
          for (const legal of ['terms', 'privacy']) {
            await page.goto('https://forge.test/fixture.html?theme=' + theme + '&page=' + legal);
            await page
              .getByRole('heading', { name: legal === 'terms' ? 'Terms' : 'Privacy policy', exact: true })
              .waitFor();
            assert.match(await page.locator('.intro').textContent(), /Draft.*owner approval/);
            assert.deepEqual(
              await context.cookies(),
              [],
              'draft pages set no non-essential or essential cookies',
            );
          }
          await context.close();
        },
      );
    }
});
