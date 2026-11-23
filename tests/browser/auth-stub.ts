// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The fixture's stand-in for the sign-in package: the page sends the token with an attachment download. The fixture
// never signs in, so the token is fixed and the other exports the bundle names do nothing.
import type { ReactNode } from 'react';

export const useAuthToken = () => 'fixture-token';
export const useAuthActions = () => ({ signIn: async () => ({}), signOut: async () => {} });
export const ConvexAuthProvider = ({ children }: { children?: ReactNode }) => children;
