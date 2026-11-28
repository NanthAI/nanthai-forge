// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { RecentLandings } = await import(moduleUrl('../web/src/app/flow/RecentLandings.tsx'));

test('Recent landings uses FYI titles by receipt ID and still identifies untitled receipts by plain sequence', () => {
  const at = '2026-11-27T15:30:00.000Z';
  const history = '/sample-one/tidepool/code';
  const html = renderToStaticMarkup(
    createElement(RecentLandings, {
      history,
      drawnAt: Date.parse(at),
      rows: [
        { receiptId: 'sample-one', sequence: 32224, at, title: null },
        { receiptId: 'sample-two', sequence: 32223, at, title: null },
      ],
      fyiLandings: [{ receiptId: 'sample-one', title: 'Stream parser: handle split UTF-8' }],
    }),
  );
  assert.match(
    html,
    /href="\/sample-one\/tidepool\/code\/sample-one"><span[^>]*>Stream parser: handle split UTF-8<\/span><span[^>]*>#32224<\/span>/,
  );
  assert.match(
    html,
    /href="\/sample-one\/tidepool\/code\/sample-two"><span[^>]*>Landing<\/span><span[^>]*>#32223<\/span>/,
  );
});
