// Shareable links: the program is compressed into the URL fragment (#s=...), so nothing is uploaded anywhere.

export interface Shared { code: string; lang: string; name?: string }

/** The hosted web app; the desktop app (file://) shares links that open there. */
export const PUBLIC_URL = 'https://brinhan.github.io/Vex-Brain-Simulator/';

const toB64Url = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function shareLink(s: Shared): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, ...s }));
  const data = toB64Url(await pipe(json, new CompressionStream('deflate-raw')));
  const base = location.protocol === 'file:' ? PUBLIC_URL : location.origin + location.pathname;
  return `${base}#s=${data}`;
}

/** Reads a program from a `#s=` fragment; undefined when there is none or it is damaged. */
export async function readShared(hash: string): Promise<Shared | undefined> {
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return undefined;
  try {
    const json = new TextDecoder().decode(await pipe(fromB64Url(m[1]), new DecompressionStream('deflate-raw')));
    const o = JSON.parse(json);
    return typeof o.code === 'string' ? { code: o.code, lang: String(o.lang ?? 'auto'), name: typeof o.name === 'string' ? o.name : undefined } : undefined;
  } catch {
    return undefined;
  }
}
