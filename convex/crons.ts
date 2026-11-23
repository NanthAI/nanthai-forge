// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.daily('purge deleted Items', { hourUTC: 0, minuteUTC: 0 }, internal.projectItemRetention.sweep);
export default crons;
