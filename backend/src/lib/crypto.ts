import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * SMTP credentials are stored encrypted at rest with AES-256-GCM.
 * Format: <iv-hex>:<authTag-hex>:<ciphertext-hex>
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const key = () => Buffer.from(env.ENCRYPTION_KEY, 'hex');

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
