// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
const credentialType = v.literal('public-key');
const descriptor = v.object({ id: v.string(), type: credentialType });
export const creationOptions = v.object({
  rp: v.object({ id: v.string(), name: v.string() }),
  user: v.object({ id: v.string(), name: v.string(), displayName: v.string() }),
  challenge: v.string(),
  pubKeyCredParams: v.array(v.object({ alg: v.number(), type: credentialType })),
  timeout: v.number(),
  excludeCredentials: v.array(descriptor),
  authenticatorSelection: v.object({
    residentKey: v.literal('required'),
    requireResidentKey: v.literal(true),
    userVerification: v.literal('required'),
  }),
  attestation: v.literal('none'),
  extensions: v.object({}),
});
// Wire contract of the pinned component. PRF/envelope ceremonies are separate.
export const registrationResponse = v.object({
  id: v.string(),
  rawId: v.string(),
  type: credentialType,
  response: v.object({
    clientDataJSON: v.string(),
    attestationObject: v.string(),
    transports: v.optional(v.array(v.string())),
  }),
  clientExtensionResults: v.object({}),
});
export const registrationResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.object({
      error: v.union(v.literal('CHALLENGE_EXPIRED'), v.literal('PROTOCOL_ERROR'), v.literal('INVALID_NAME')),
    }),
  }),
);
export const b64url = (bytes: ArrayBuffer) => {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const authenticationResponse = v.object({
  id: v.string(),
  rawId: v.string(),
  type: v.literal('public-key'),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.string()),
  }),
  clientExtensionResults: v.object({}),
});
export const requestOptions = v.object({
  challenge: v.string(),
  timeout: v.number(),
  rpId: v.string(),
  allowCredentials: v.array(
    v.object({ id: v.string(), type: v.literal('public-key'), transports: v.optional(v.array(v.string())) }),
  ),
  userVerification: v.literal('required'),
});
