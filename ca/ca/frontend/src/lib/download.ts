/**
 * Shared client-side download helpers ensuring Blob URLs are never revoked
 * prematurely and ZIP bundle downloads are verified before saving to disk.
 */

const REVOKE_DELAY_MS = 60_000;

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revocation so the browser download manager always finishes reading the Blob.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

/**
 * Validates that downloaded bytes form a complete, non-truncated ZIP archive
 * (Local File Header PK\x03\x04 + valid EOCD PK\x05\x06 + Central Directory PK\x01\x02).
 * Rejects HTML proxy interstitials, JSON error responses, or partial transfers.
 */
export function isValidZipBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.byteLength < 22) return false;
  const startsLocal =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!startsLocal) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen !== bytes.byteLength) continue;
      const cdSize = view.getUint32(i + 12, true);
      const cdOffset = view.getUint32(i + 16, true);
      if (cdOffset + cdSize > i) continue;
      if (cdSize > 0) {
        if (
          bytes[cdOffset] !== 0x50 ||
          bytes[cdOffset + 1] !== 0x4b ||
          bytes[cdOffset + 2] !== 0x01 ||
          bytes[cdOffset + 3] !== 0x02
        ) {
          continue;
        }
      }
      return true;
    }
  }
  return false;
}

export interface FetchBundleOptions {
  url?: string;
  filename?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches the project ZIP bundle via fetch() (keeping iframe/proxy session cookies),
 * verifies Content-Length and ZIP binary integrity, automatically retries if the first
 * request was intercepted by a cold-start or proxy interstitial, and only triggers a
 * browser download once a verified intact ZIP buffer is received.
 */
export async function fetchVerifiedZipBundle(options: FetchBundleOptions = {}): Promise<Uint8Array> {
  const url = options.url ?? '/api/demo/download-bundle';
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 350;
  const doFetch = options.fetchImpl ?? fetch;

  let lastError = 'Invalid or incomplete ZIP archive returned by server';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sep = url.includes('?') ? '&' : '?';
      const bustUrl = `${url}${sep}t=${Date.now()}&attempt=${attempt}`;
      const res = await doFetch(bustUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/zip, application/octet-stream',
        },
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status} while downloading bundle`;
      } else {
        const expectedLenHeader = res.headers.get('content-length');
        const expectedLen = expectedLenHeader ? Number(expectedLenHeader) : NaN;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);

        const lengthOk =
          !Number.isFinite(expectedLen) || expectedLen <= 0 || bytes.byteLength === expectedLen;

        if (lengthOk && isValidZipBytes(bytes)) {
          return bytes;
        }
        lastError = !lengthOk
          ? `Incomplete download (${bytes.byteLength}/${expectedLen} bytes)`
          : 'Server returned non-ZIP or corrupted archive payload';
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Network error downloading bundle';
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw new Error(lastError);
}

export async function downloadProjectBundle(filename = 'wimotek-pki-suite.zip'): Promise<void> {
  const bytes = await fetchVerifiedZipBundle({ filename });
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  triggerBlobDownload(new Blob([copy], { type: 'application/zip' }), filename);
}
