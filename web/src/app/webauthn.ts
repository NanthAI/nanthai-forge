// SPDX-License-Identifier: Apache-2.0
// The browser leg of adding a passkey (convex/authPasskeys.ts): the server's creation options in, the
// registration response out, in exactly the wire shape that function accepts (no extensions, no extra fields).
// Sign-in itself uses the auth library's own ceremony.

export type CreationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { alg: number; type: 'public-key' }[];
  timeout: number;
  excludeCredentials: { id: string; type: 'public-key' }[];
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' };
  attestation: 'none';
  extensions: Record<string, never>;
};
export type RegistrationWire = {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults: Record<string, never>;
};
export type CeremonyFailure = 'unsupported' | 'closed' | 'exists' | 'failed';

export function toBytes(base64url: string): ArrayBuffer {
  const text = atob(
    base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4),
  );
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes.buffer;
}
export function toBase64url(bytes: ArrayBuffer): string {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Runs the create ceremony. A closed prompt or an existing passkey is a plain answer, never an exception. */
export async function createPasskey(
  options: CreationOptions,
  credentials: Pick<CredentialsContainer, 'create'> | undefined = globalThis.navigator?.credentials,
): Promise<{ ok: true; wire: RegistrationWire } | { ok: false; failure: CeremonyFailure }> {
  if (!credentials || typeof PublicKeyCredential === 'undefined')
    return { ok: false, failure: 'unsupported' };
  let credential: Credential | null;
  try {
    credential = await credentials.create({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: options.excludeCredentials.map(item => ({ ...item, id: toBytes(item.id) })),
      },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    return {
      ok: false,
      failure: name === 'InvalidStateError' ? 'exists' : name === 'NotAllowedError' ? 'closed' : 'failed',
    };
  }
  const key = credential as PublicKeyCredential | null;
  const response = key?.response as AuthenticatorAttestationResponse | undefined;
  if (!key || !response?.attestationObject) return { ok: false, failure: 'failed' };
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
  return {
    ok: true,
    wire: {
      id: key.id,
      rawId: toBase64url(key.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        attestationObject: toBase64url(response.attestationObject),
        ...(transports?.length ? { transports } : {}),
      },
      clientExtensionResults: {},
    },
  };
}

type AssertionOptions = {
  challenge: string;
  timeout: number;
  rpId: string;
  allowCredentials: { id: string; type: 'public-key'; transports?: string[] }[];
  userVerification: 'required';
};
export async function assertPasskey(
  options: AssertionOptions,
  credentials: Pick<CredentialsContainer, 'get'> = navigator.credentials,
) {
  const key = (await credentials.get({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: options.allowCredentials.map(value => ({
        ...value,
        id: toBytes(value.id),
        transports: value.transports as AuthenticatorTransport[] | undefined,
      })),
    },
  })) as PublicKeyCredential | null;
  if (!key) throw new Error('Passkey confirmation closed.');
  const response = key.response as AuthenticatorAssertionResponse;
  return {
    id: key.id,
    rawId: toBase64url(key.rawId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
    },
    clientExtensionResults: {},
  };
}
