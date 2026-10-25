import { describe, expect, it } from 'vitest';
import { b64urlToBytes, encryptPayload } from '../src/push';
import { decryptPayload, RFC8291_UA } from './push-decrypt';

// The encrypted message of the RFC 8291 Section 5 worked example.
const RFC_MESSAGE =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('decryptPayload', () => {
  it('decrypts the RFC 8291 worked example', async () => {
    const plain = await decryptPayload(b64urlToBytes(RFC_MESSAGE), RFC8291_UA);
    expect(text(plain)).toBe('When I grow up, I want to be a watermelon');
  });

  it('round-trips a randomly keyed encryptPayload', async () => {
    const message = JSON.stringify({ title: 'Mon 12 Oct 08:00 - ETD now 09:00', url: '/?t=x' });
    const body = await encryptPayload(
      new TextEncoder().encode(message),
      b64urlToBytes(RFC8291_UA.publicKey),
      b64urlToBytes(RFC8291_UA.authSecret),
    );
    expect(text(await decryptPayload(body, RFC8291_UA))).toBe(message);
  });

  it('rejects a message for another auth secret', async () => {
    const body = await encryptPayload(
      new TextEncoder().encode('secret'),
      b64urlToBytes(RFC8291_UA.publicKey),
      crypto.getRandomValues(new Uint8Array(16)),
    );
    await expect(decryptPayload(body, RFC8291_UA)).rejects.toThrow();
  });
});
