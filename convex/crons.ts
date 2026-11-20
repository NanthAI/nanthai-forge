// SPDX-License-Identifier: Apache-2.0
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.daily('purge deleted Items', { hourUTC: 0, minuteUTC: 0 }, internal.projectItemRetention.sweep);
export default crons;
