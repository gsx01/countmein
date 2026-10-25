import http from 'node:http';
import { b64urlToBytes } from '../src/push';
import { decryptPayload, RFC8291_UA } from '../test/push-decrypt';
import { PUSH_BASE, PUSH_PORT, VAPID } from './env';

export interface ReceivedPush {
  // The endpoint path without the slash: the subscriber's Who.
  to: string;
  payload: { title: string; body: string; url: string; tag?: string };
}

export interface PushService {
  received: ReceivedPush[];
  // Requests that failed a check; a spec expects none.
  rejected: string[];
  clear(): void;
  close(): Promise<void>;
}

const decoder = new TextDecoder();
const json = (part: string) => JSON.parse(decoder.decode(b64urlToBytes(part)));

// Checks a request the way a push service would, returning what is wrong.
async function problems(req: http.IncomingMessage): Promise<string[]> {
  const out: string[] = [];
  if (req.method !== 'POST') out.push(`method ${req.method}`);
  if (req.headers['content-encoding'] !== 'aes128gcm') out.push('content-encoding is not aes128gcm');
  if (!/^\d+$/.test(String(req.headers.ttl ?? ''))) out.push('no numeric TTL');

  const auth = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(req.headers.authorization ?? '');
  if (!auth) return [...out, `bad Authorization: ${req.headers.authorization}`];
  const [, jwt, k] = auth;
  if (k !== VAPID.publicKey) out.push('k is not the run key');

  const [header, claims, signature] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    b64urlToBytes(k),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64urlToBytes(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  if (!valid) out.push('JWT signature does not verify for k');
  if (json(header).alg !== 'ES256') out.push('JWT alg is not ES256');
  const c = json(claims) as { aud?: string; exp?: number; sub?: string };
  if (c.aud !== PUSH_BASE) out.push(`JWT aud ${c.aud}`);
  if (!(typeof c.exp === 'number' && c.exp > Date.now() / 1000)) out.push(`JWT exp ${c.exp}`);
  if (!c.sub) out.push('JWT has no sub');
  return out;
}

// A local stand-in for FCM and friends. Every scenario subscription points at
// `${PUSH_BASE}/<who>` with the RFC 8291 user-agent keys, so it can decrypt what
// the Worker sends.
export async function startPushService(): Promise<PushService> {
  const service: PushService = {
    received: [],
    rejected: [],
    clear() {
      service.received.length = 0;
      service.rejected.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const handle = async (req: http.IncomingMessage, body: Buffer): Promise<number> => {
    const wrong = await problems(req);
    if (wrong.length > 0) {
      service.rejected.push(`${req.url}: ${wrong.join('; ')}`);
      return 400;
    }
    const plain = await decryptPayload(new Uint8Array(body), RFC8291_UA);
    service.received.push({ to: (req.url ?? '').slice(1), payload: JSON.parse(decoder.decode(plain)) });
    return 201;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      handle(req, Buffer.concat(chunks))
        .catch((err: Error) => {
          service.rejected.push(`${req.url}: ${err.message}`);
          return 400;
        })
        .then((status) => {
          res.writeHead(status);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(PUSH_PORT, '127.0.0.1', resolve));
  return service;
}
