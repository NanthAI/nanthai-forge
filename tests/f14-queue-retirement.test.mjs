// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function tokens(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText());
  return result;
}

const source = path => readFileSync(new URL(`../convex/${path}`, import.meta.url), 'utf8');
const hasPresenceTimestamp = text => /(?:^| )presenceRow (?:\?\.|\.) at(?: |$)/.test(tokens(text).join(' '));
const hasTableWrapper = text => tokens(text).includes('workRecordTable');

test('F14 supersession reads only the retained Lane activity timestamp', () => {
  assert(!hasPresenceTimestamp(source('projectHostedSuperseded.ts')));
  assert(hasPresenceTimestamp('const activity = row?.lastActivityAt ?? row?.presenceRow?.at ?? Infinity;'));
});

test('F14 check imports and the shared table selector cannot reintroduce workRecordTable', () => {
  assert(!hasTableWrapper(source('projectHostedCheckImport.ts')));
  assert(!hasTableWrapper(source('projectWorkRecordTables.ts')));
  assert(hasTableWrapper("await workRecordTable(ctx, partition, 'checks:payload')"));
});
