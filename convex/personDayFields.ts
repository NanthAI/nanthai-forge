// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const personDayTables = {
  // A person's contributions (Item 6a251b23): one row per person (account id) per active UTC day, with that day's
  // counts per project as a `PersonDay` (src/person-days.ts). Written only by each project's day close.
  personDays: defineTable({
    person: v.string(),
    day: v.string(),
    value: v.string(),
  }).index('by_person_and_day', ['person', 'day']),
};
