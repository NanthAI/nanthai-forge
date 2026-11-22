// SPDX-License-Identifier: Apache-2.0
// The Review page's decision panel (Item e6f1290b) on synthetic data, through its real component: `?s=ready` has a
// passing check, `?s=unchecked` has none (the fact line beside Approve), `?s=held` is a landing held for review
// before any check ran, `?s=held-checked` the same with a run. Fixtures are tests/fixtures/landing-review.mjs.
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/ui/components.css';
import '../../web/src/lane/lane.css';
import { LandingDecision } from '../../web/src/lane/LandingDecision';
// @ts-expect-error plain module shared with the render tests
import { landingRead, variantProps } from '../fixtures/landing-review.mjs';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const scenario = params.get('s') ?? 'ready';
const base = variantProps('01-ready');
const props =
  scenario === 'held' || scenario === 'held-checked'
    ? {
        ...variantProps('02-queued'),
        read: {
          ...landingRead('waiting-for-review'),
          run: scenario === 'held' ? null : landingRead('checking').run,
        },
        review: { accept() {}, decline() {} },
      }
    : { ...base, unchecked: scenario === 'unchecked' };
createRoot(document.getElementById('root')!).render(
  <main className="fx fx-page">
    <LandingDecision {...props} />
  </main>,
);
