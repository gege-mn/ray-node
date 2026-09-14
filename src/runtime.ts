/**
 * Small runtime shims so the SDK runs unchanged on Node 18+, Bun, Deno,
 * Cloudflare Workers and Vercel Edge without importing any Node built-in at
 * module load time.
 */

export const VERSION = '0.1.0';

/** Reads an environment variable when a `process.env` exists (Node, Bun, Deno 2). */
export function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

let cryptoPromise: Promise<Crypto> | undefined;

/**
 * Returns a Web Crypto implementation. Every supported runtime exposes
 * `globalThis.crypto` except Node 18, where it lives on `node:crypto`'s
 * `webcrypto` export. The module specifier is kept out of static analysis so
 * edge bundlers never try to resolve `node:crypto`.
 */
export function getWebCrypto(): Promise<Crypto> {
  const global = (globalThis as { crypto?: Crypto }).crypto;
  if (global?.subtle) return Promise.resolve(global);
  if (!cryptoPromise) {
    const specifier = ['node', 'crypto'].join(':');
    cryptoPromise = (
      import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as Promise<{
        webcrypto?: Crypto;
      }>
    ).then((mod) => {
      if (!mod.webcrypto?.subtle) {
        throw new Error(
          '@gege-mn/ray: Web Crypto (crypto.subtle) is not available in this runtime',
        );
      }
      return mod.webcrypto;
    });
  }
  return cryptoPromise;
}

/** RFC 4122 v4 UUID from the runtime's Web Crypto. */
export async function randomUUID(): Promise<string> {
  const crypto = await getWebCrypto();
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
