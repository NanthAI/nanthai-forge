// SPDX-License-Identifier: Apache-2.0
// Test double for @clerk/react: a signed-in viewer named in globalThis.__forgeTree.
import { createElement, Fragment } from 'react';
const viewer = () => globalThis.__forgeTree?.viewer ?? { id: 'viewer', fullName: 'Test Viewer' };
export const ClerkProvider = ({ children }) => createElement(Fragment, null, children);
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: viewer().id, getToken: async () => null });
export const useUser = () => ({
  isLoaded: true,
  isSignedIn: true,
  user: { ...viewer(), primaryEmailAddress: { emailAddress: 'viewer@example.com' } },
});
export const SignInButton = ({ children }) => createElement(Fragment, null, children);
export const UserButton = () => createElement('span', { className: 'fx-av fx-av-human' }, 'TV');

export const SignOutButton = ({ children }) => createElement(Fragment, null, children);

export const useClerk = () => ({ openUserProfile() {} });
