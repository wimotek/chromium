export interface PasskeyRegisterOptions {
  challenge: string;
  rpId: string;
  rpName: string;
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  excludeCredentials?: Array<{ id: string; type: 'public-key' }>;
}

export interface PasskeyRegisterPayload {
  challenge: string;
  credentialId: string;
  publicKeySpki: string;
  algorithm: number;
  clientDataJSON: string;
  authenticatorData: string;
  label: string;
  userId?: string;
}

export interface PasskeyAuthOptions {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string; type: 'public-key' }>;
}

export interface PasskeyAuthPayload {
  challenge: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function checkWebAuthnAvailability(): { ok: boolean; reason?: string } {
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'WebAuthn requires a browser environment.' };
  }
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'Passkeys (WebAuthn) require a secure HTTPS origin or localhost. Access this service via HTTPS (e.g. port 8443 or reverse proxy) to register and sign in with Passkeys.',
    };
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    return {
      ok: false,
      reason: 'Your browser does not support WebAuthn Passkeys.',
    };
  }
  return { ok: true };
}

export async function registerBrowserPasskey(
  options: PasskeyRegisterOptions,
  label: string,
  userId?: string,
): Promise<PasskeyRegisterPayload> {
  const avail = checkWebAuthnAvailability();
  if (!avail.ok) {
    throw new Error(avail.reason);
  }

  const encoder = new TextEncoder();
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: toArrayBuffer(base64UrlToBytes(options.challenge)),
    rp: {
      id: options.rpId,
      name: options.rpName || 'wimotek/Oauth',
    },
    user: {
      id: toArrayBuffer(encoder.encode(options.user.id)),
      name: options.user.name,
      displayName: options.user.displayName || options.user.name,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256 (P-256)
      { type: 'public-key', alg: -257 }, // RS256
    ],
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      type: 'public-key',
      id: toArrayBuffer(base64UrlToBytes(c.id)),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    timeout: 60000,
    attestation: 'none',
  };

  let credential: Credential | null = null;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new Error('Passkey registration was cancelled or timed out.');
    }
    if (err instanceof DOMException && err.name === 'InvalidStateError') {
      throw new Error('This authenticator already has a Passkey registered for this account.');
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new Error(`WebAuthn domain mismatch for RP ID "${options.rpId}". Ensure the browser hostname matches the configured Issuer domain or access via localhost/HTTPS.`);
    }
    throw new Error(err instanceof Error ? err.message : 'Browser Passkey creation failed.');
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('No WebAuthn public-key credential was returned by the authenticator.');
  }

  const pkCred = credential as PublicKeyCredential;
  const response = pkCred.response as AuthenticatorAttestationResponse;

  if (typeof response.getPublicKey !== 'function') {
    throw new Error('This browser does not expose SPKI public keys via WebAuthn getPublicKey(). Please use a modern Chrome, Edge, Safari, or Firefox browser.');
  }
  const spkiBuffer = response.getPublicKey();
  if (!spkiBuffer) {
    throw new Error('Authenticator did not return a verifiable SPKI public key.');
  }
  const alg = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : -7;
  const authData = typeof response.getAuthenticatorData === 'function' ? response.getAuthenticatorData() : new ArrayBuffer(0);

  return {
    challenge: options.challenge,
    credentialId: pkCred.id,
    publicKeySpki: bytesToBase64Url(spkiBuffer),
    algorithm: alg,
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    authenticatorData: bytesToBase64Url(authData),
    label: label.trim() || 'Browser Passkey',
    userId,
  };
}

export async function authenticateBrowserPasskey(options: PasskeyAuthOptions): Promise<PasskeyAuthPayload> {
  const avail = checkWebAuthnAvailability();
  if (!avail.ok) {
    throw new Error(avail.reason);
  }

  if (!options.allowCredentials || options.allowCredentials.length === 0) {
    throw new Error('No registered Passkeys found for this account.');
  }

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toArrayBuffer(base64UrlToBytes(options.challenge)),
    rpId: options.rpId,
    allowCredentials: options.allowCredentials.map((c) => ({
      type: 'public-key',
      id: toArrayBuffer(base64UrlToBytes(c.id)),
    })),
    userVerification: 'preferred',
    timeout: 60000,
  };

  let credential: Credential | null = null;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new Error('Passkey sign-in was cancelled or no matching Passkey is available on this device.');
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new Error(`WebAuthn domain mismatch for RP ID "${options.rpId}".`);
    }
    throw new Error(err instanceof Error ? err.message : 'Browser Passkey authentication failed.');
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('No WebAuthn assertion was returned by the authenticator.');
  }

  const pkCred = credential as PublicKeyCredential;
  const response = pkCred.response as AuthenticatorAssertionResponse;

  return {
    challenge: options.challenge,
    credentialId: pkCred.id,
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    authenticatorData: bytesToBase64Url(response.authenticatorData),
    signature: bytesToBase64Url(response.signature),
  };
}
