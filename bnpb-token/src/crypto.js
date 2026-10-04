import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(secret, Buffer.from(saltHex, 'hex'), KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
