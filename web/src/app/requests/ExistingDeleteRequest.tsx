// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ClerkProvider, SignInButton } from '@clerk/react';
import { useConvexAuth, type ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { useConvexTokenAuth } from '../../clerk-convex-auth';
import { Key } from '../../ds';
import { PublicFrame } from '../frames';
import { deleteRequestHref } from '../paths';
import DeleteRequest from './DeleteRequest';

export default function ExistingDeleteRequest({
  client,
  requestId,
  publishableKey,
}: {
  client: ConvexReactClient;
  requestId: string;
  publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ConvexProviderWithClerk client={client} useAuth={useConvexTokenAuth}>
        <PublicFrame wide>
          <Review requestId={requestId} />
        </PublicFrame>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function Review({ requestId }: { requestId: string }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const href = deleteRequestHref(requestId);
  if (isLoading) return <p aria-busy="true">Opening your existing sign-in…</p>;
  if (!isAuthenticated)
    return (
      <div className="intro">
        <h1>Sign in to review the delete request</h1>
        <SignInButton mode="modal">
          <Key kind="primary">Continue with your existing sign-in</Key>
        </SignInButton>
        <p>
          <a href={href}>Use a passkey or GitHub</a>
        </p>
      </div>
    );
  return <DeleteRequest requestId={requestId} alternate={{ href, label: 'Use a passkey or GitHub' }} />;
}
