// SPDX-License-Identifier: Apache-2.0
import { hostedHref } from '../cockpit/HostedNow';
export const hostedViewHref = (viewId: string) => hostedHref({ projectTab: 'views', viewId });
