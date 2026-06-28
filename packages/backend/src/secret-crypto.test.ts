import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-crypto.js';

describe('social token encryption', () => {
  it('round-trips encrypted provider tokens', async () => {
    const encrypted = await encryptSecret('page-access-token', 'strong-test-secret');
    const plaintext = await decryptSecret(encrypted.ciphertext, encrypted.iv, 'strong-test-secret');

    expect(plaintext).toBe('page-access-token');
    expect(encrypted.ciphertext).not.toContain('page-access-token');
  });

  it('rejects decryption with the wrong key material', async () => {
    const encrypted = await encryptSecret('page-access-token', 'strong-test-secret');

    await expect(decryptSecret(encrypted.ciphertext, encrypted.iv, 'different-secret')).rejects.toThrow();
  });
});
