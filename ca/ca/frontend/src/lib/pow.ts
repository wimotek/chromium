export interface PowChallenge {
  challenge: string;
  difficulty: number;
  expires_at: number;
}

export function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(digest);
}

/**
 * Solves a stateless HMAC-signed SHA-256 offline PoW challenge in the browser using WebCrypto.
 * Yields periodically so the main UI thread never freezes.
 */
export async function solvePowChallenge(
  challenge: string,
  difficulty: number,
  onProgress?: (iterations: number) => void
): Promise<{ solution: string; iterations: number; elapsedMs: number }> {
  const start = performance.now();
  let nonce = 0;

  while (true) {
    const candidate = String(nonce);
    const hash = await sha256Bytes(`${challenge}:${candidate}`);
    if (hasLeadingZeroBits(hash, difficulty)) {
      return {
        solution: candidate,
        iterations: nonce + 1,
        elapsedMs: Math.round(performance.now() - start),
      };
    }
    nonce++;
    if (nonce % 400 === 0) {
      onProgress?.(nonce);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}
