import { describe, expect, it } from 'vitest';
import { createSession, verifySession } from './auth.js';

describe('session auth', () => {
  it('verifies sessions signed with the configured key', async () => {
    const token = await createSession({ uid: 'google:1', email: 'user@example.com' }, 'signing-secret');
    const claims = await verifySession(token, 'signing-secret');

    expect(claims?.uid).toBe('google:1');
    expect(claims?.email).toBe('user@example.com');
  });

  it('rejects tampered and expired sessions', async () => {
    const token = await createSession({ uid: 'google:1', email: 'user@example.com' }, 'signing-secret', -1);
    const validToken = await createSession({ uid: 'google:1', email: 'user@example.com' }, 'signing-secret');

    expect(await verifySession(token, 'signing-secret')).toBeNull();
    expect(await verifySession(`${validToken.slice(0, -1)}x`, 'signing-secret')).toBeNull();
    expect(await verifySession(validToken, 'wrong-secret')).toBeNull();
  });
});
