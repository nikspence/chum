import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const secret = (bytes = 32) => randomBytes(bytes).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password, salt = secret(16)) {
  const hash = await derive(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const result = await passwordHash(password, salt);
  return timingSafeEqual(Buffer.from(result.split(':')[1], 'hex'), Buffer.from(hash, 'hex'));
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
export function itemName(value) {
  requireValue(typeof value === 'string', 400, 'A name is required.');
  const name = value.trim().normalize('NFC');
  requireValue(name.length > 0 && name.length <= 180 && Buffer.byteLength(name) <= 240 &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) &&
    !['.', '..'].includes(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name),
  400, 'Invalid file or folder name.');
  return name;
}
