import { decryptAesGcm, encryptAesGcm } from './crypto-gcm.js';

export async function encryptSecret(plaintext: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  return encryptAesGcm(plaintext, secret);
}

export async function decryptSecret(ciphertext: string, iv: string, secret: string): Promise<string> {
  return decryptAesGcm(ciphertext, iv, secret);
}
