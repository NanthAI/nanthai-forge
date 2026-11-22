// SPDX-License-Identifier: Apache-2.0
import { ROOT } from './paths';

/** The address the CLI printed before sign-in moved into the app (`/device`) opens the app's Device page. */
export function normalizeDevicePathname(pathname: string) {
  return /^\/device\/?$/.test(pathname) ? `${ROOT}/device` : pathname;
}
