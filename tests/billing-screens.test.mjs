// SPDX-License-Identifier: Apache-2.0
// Billing screens on stubs (Items 1fbf61b9, 989c5695, 7f9a23e8, 176db9fb), rendered through the real components.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertDrawn, billingFixture, shots } from './billing-fixture.mjs';

const text = async tab => (await tab.locator('main').textContent()).replace(/\s+/g, ' ');

test('billing screens: plan change, invoices, payment details and held states, in both themes and widths', async t => {
  const fixture = await billingFixture(t);
  if (!fixture) return t.skip('Playwright Chromium is not installed.');
  const { open } = fixture;

  // Change plan: one comparison table, what changes and when, and the hosted payment handoff.
  const plan = await open('sample=hobby&screen=plan');
  assert.equal(
    await plan.getByRole('table', { name: 'Plans compared, sample data' }).locator('tbody tr').count(),
    3,
  );
  assert.match(await text(plan), /Pro fits your pace: about 556 landings a month/);
  assert.match(await text(plan), /15 of 30 days\. The full 1,000 landings are included: 278 used, 722 left/);
  assert.doesNotMatch(await text(plan), /yearly/i);
  await plan.getByRole('button', { name: 'Continue to the payment page to pay $7.50' }).click();
  assert.match(await text(plan), /The payment page is open/);
  await plan.getByRole('button', { name: 'no answer' }).click();
  assert.match(await plan.locator('.notice[data-st=waiting]').textContent(), /Do not pay again/);
  assert.equal(await plan.getByRole('button', { name: /pay \$7\.50/ }).count(), 0, 'no second pay button');
  await plan.getByRole('button', { name: 'Check now' }).click();
  await plan.getByRole('button', { name: 'paid' }).click();
  assert.match(await text(plan), /\$7\.50 paid\. You are on Pro: 722 landings left/);
  const declined = await open('sample=hobby&screen=plan&step=declined', 390);
  assert.match(
    await declined.getByRole('alert').textContent(),
    /Nothing was charged and you are still on Hobby/,
  );
  assert.equal(await declined.getByRole('button', { name: 'Try another card' }).count(), 1);
  const up = await open('sample=over&screen=plan');
  assert.match(await text(up), /Team costs \$16 less than Pro this month at your pace/);
  assert.match(await text(up), /2 blocks started on Pro, now inside Team: not billed/);
  const down = await open('sample=quiet&screen=plan');
  assert.match(await text(down), /Pro would cost about \$14 less a month at your pace/);
  await down.getByRole('button', { name: 'Move to Pro on 1 December' }).click();
  assert.match(await text(down), /would start on 1 December; nothing changed/);

  // Invoices: one statement component; list or invoice on a phone; correction request keeps what was typed.
  const late = await open('sample=late&screen=invoices');
  assert.match(await text(late), /1 invoice is not paid: \$15\.00\. Landings carry on until 22 November/);
  const states = await late.locator('.billing-invt tbody .st').allTextContents();
  assert.deepEqual(states, ['Not paid', 'Paid', 'Refunded', 'Paid']);
  await late.getByRole('link', { name: 'SAMPLE-0002' }).click();
  assert.match(late.url(), /invoice=SAMPLE-0002/);
  assert.equal(await late.getByRole('region', { name: 'SAMPLE-0002' }).count(), 1);
  const phone = await open('sample=pro&screen=invoices&invoice=SAMPLE-0003&step=fails', 390);
  assert.equal(await phone.getByRole('region', { name: 'Invoices', exact: true }).isVisible(), false);
  assert.equal(await phone.getByRole('link', { name: 'All invoices' }).isVisible(), true);
  await phone.getByRole('button', { name: 'Ask for a corrected invoice' }).click();
  await phone.getByLabel('What it should say').fill('Bill the organisation, not the person');
  await phone.getByRole('button', { name: 'Send the request' }).click();
  assert.match(await phone.getByRole('alert').textContent(), /What you typed is kept/);
  assert.equal(
    await phone.getByLabel('What it should say').inputValue(),
    'Bill the organisation, not the person',
  );
  await phone.getByRole('button', { name: 'Send the request again' }).click();
  assert.match(await text(phone), /Nothing is sent in this preview/);
  const down2 = await open('sample=pro&view=error&screen=invoices');
  assert.match(await down2.getByRole('alert').textContent(), /payment provider did not answer/);
  assert.equal(await down2.getByRole('button', { name: 'Download PDF' }).isDisabled(), true);
  assert.match(
    await text(await open('sample=hobby&screen=invoices')),
    /No invoices.*An invoice appears here/,
  );
  assert.match(
    await text(await open('sample=pro&view=manager&screen=invoices')),
    /Projects, source and people stay with @sample-owner/,
  );
  assert.equal(
    await (await open('sample=pro&view=member&screen=invoices')).locator('.billing-invt').count(),
    0,
  );
  assert.equal(
    await (await open('sample=pro&view=loading&screen=invoices')).locator('[aria-busy=true]').count(),
    1,
  );

  // Payment and details: the limit with its monthly maximum, hosted card handoff, failed edits kept.
  const pay = await open('sample=pro&screen=payment');
  assert.equal(await pay.getByRole('radio', { name: /Up to 2 blocks/ }).isChecked(), true);
  assert.match(await text(pay), /The most a month on Pro can cost: \$35 before tax/);
  await pay.getByRole('radio', { name: /No limit/ }).check();
  assert.match(await text(pay), /not known in advance/);
  await pay.getByRole('button', { name: 'Undo' }).click();
  assert.equal(await pay.getByRole('radio', { name: /Up to 2 blocks/ }).isChecked(), true);
  await pay.getByRole('button', { name: 'Replace the card' }).click();
  assert.match(await text(pay), /Forge never sees or stores the card number/);
  const invalid = await open('sample=pro&screen=payment&step=invalid', 390);
  assert.match(await invalid.locator('#billing-taxId-error').textContent(), /Nothing was saved/);
  assert.equal(await invalid.getByLabel('Tax ID, optional').inputValue(), 'XX123');
  assert.match(await text(await open('sample=hobby&screen=payment')), /No card on file/);
  assert.match(
    await text(await open('sample=pro&view=manager&screen=payment')),
    /stopping the plan, stay with @sample-owner/,
  );
  assert.match(
    await text(await open('sample=late&screen=payment')),
    /tried on 1 November, 4 November, 8 November/,
  );

  // Held states: one source for decision, Lane, row and agent; automatic continuation; recovery timeline.
  const at = await open('sample=hobby&screen=limit&step=at');
  assert.match(await text(at), /Land the 2 waiting Lanes now, or wait until 1 December\?/);
  assert.match(await text(at), /no grace landing/);
  assert.match(
    await at.locator('.billing-tell').textContent(),
    /retry {2}not needed; your landing keeps its place/,
  );
  assert.match(
    await text(at),
    /Hobby plan · Landings wait · 300 of 300, to 1 December.*plan landings are waiting: 300 of 300 used only @sample-owner can answer/,
  );
  assert.match(
    await text(await open('sample=hobby&screen=limit&step=pace')),
    /14 landings left in November\. At this pace they are used today/,
  );
  assert.match(await text(await open('sample=hobby&screen=limit&step=resumed')), /Nothing to resubmit/);
  assert.match(
    await text(await open('sample=late&screen=limit&step=failed')),
    /22 November.*Nothing is deleted.*8 November/,
  );

  for (const tab of [plan, late, pay, at])
    assert.equal(await tab.locator('input[autocomplete^="cc-"]').count(), 0, 'no card fields');

  const screens = [
    ['plan', 'sample=hobby&screen=plan'],
    ['invoices', 'sample=late&screen=invoices'],
    ['payment', 'sample=pro&screen=payment'],
    ['limit', 'sample=hobby&screen=limit&step=at'],
  ];
  for (const [name, query] of screens)
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        const draw = await open(query, width, theme);
        await assertDrawn(draw, `${name} ${width}/${theme}`);
        await draw.getByRole('button', { name: /^nforge / }).focus();
        await draw.keyboard.press('Enter');
        assert.equal(
          await draw.locator('#billing-cli').count(),
          1,
          `${name}: keyboard opens the command reply`,
        );
        if (shots)
          await draw.screenshot({
            path: join(shots, `billing-${name}-${width}-${theme}.png`),
            fullPage: true,
          });
        await draw.close();
      }
});
