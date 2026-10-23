import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await deriveKey(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, hex] = encoded.split(':');
  if (!salt || !hex) return false;
  const stored = Buffer.from(hex, 'hex');
  const actual = (await deriveKey(password, salt, 64)) as Buffer;
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}
