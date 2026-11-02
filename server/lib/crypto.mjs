import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const newId = (prefix) => prefix + '_' + randomBytes(9).toString('hex');
export const newCode = () => String(randomInt(100000, 1000000));

export function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(pin), salt, 32).toString('hex') };
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function verifyPin(pin, salt, hash) {
  return safeEqualHex(scryptSync(String(pin), salt, 32).toString('hex'), hash);
}
