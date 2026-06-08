/**
 * User API Key Vault — encrypted per-user API keys for AI providers.
 *
 * Keys are AES-256-GCM encrypted using SESSION_SIGNING_KEY as the master key.
 * Simpler than PAS's envelope encryption — sufficient for a single-worker store.
 *
 * Routes:
 *   GET    /keys/providers         -> list supported AI providers
 *   GET    /keys/status            -> which providers user has keys for
 *   POST   /keys/set               -> store an encrypted API key
 *   DELETE /keys/:provider         -> remove a key
 *   GET    /keys/resolve/:provider -> decrypt + return key (internal only)
 */

import { Hono } from 'hono';
import { requireUser, HttpError } from './auth.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const keysRoutes = new Hono<AppEnv>();

// ── Supported providers ──────────────────────────────────────────────

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', prefix: 'sk-' },
  { id: 'anthropic', name: 'Anthropic', prefix: 'sk-ant-' },
  { id: 'google', name: 'Google AI', prefix: null },
  { id: 'replicate', name: 'Replicate', prefix: 'r8_' },
  { id: 'stability', name: 'Stability AI', prefix: 'sk-' },
] as const;

// ── AES-256-GCM encryption ──────────────────────────────────────────

const IV_LENGTH = 12;

async function deriveKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptKey(
  plaintext: string,
  secret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    ciphertext: uint8ToBase64(new Uint8Array(encrypted)),
    iv: uint8ToBase64(iv),
  };
}

export async function decryptKey(
  ciphertext: string,
  iv: string,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToUint8(iv) },
    key,
    base64ToUint8(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Routes ───────────────────────────────────────────────────────────

keysRoutes.get('/keys/providers', (c) => {
  return c.json({
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
  });
});

keysRoutes.get('/keys/status', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT provider, created_at FROM keys WHERE user_id = ?',
  )
    .bind(user.uid)
    .all<{ provider: string; created_at: string }>();
  return c.json({
    keys: rows.results.map((r) => ({
      provider: r.provider,
      createdAt: r.created_at,
    })),
  });
});

keysRoutes.post('/keys/set', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{ provider: string; key: string }>();

  if (!body.provider || !body.key || typeof body.key !== 'string') {
    throw new HttpError('provider and key are required', 400);
  }
  if (body.key.length > 500) {
    throw new HttpError('key too long (max 500 chars)', 400);
  }

  const prov = PROVIDERS.find((p) => p.id === body.provider);
  if (!prov) {
    throw new HttpError(`unknown provider: ${body.provider}`, 400);
  }
  if (prov.prefix && !body.key.startsWith(prov.prefix)) {
    throw new HttpError(`key should start with "${prov.prefix}"`, 400);
  }

  const { ciphertext, iv } = await encryptKey(body.key, c.env.SESSION_SIGNING_KEY);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO keys (id, user_id, provider, encrypted_key, iv, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, provider) DO UPDATE SET
       encrypted_key = excluded.encrypted_key,
       iv = excluded.iv,
       created_at = excluded.created_at`,
  )
    .bind(id, user.uid, body.provider, ciphertext, iv)
    .run();

  return c.json({ ok: true });
});

keysRoutes.delete('/keys/:provider', async (c) => {
  const user = await requireUser(c);
  const provider = c.req.param('provider');

  const result = await c.env.DB.prepare(
    'DELETE FROM keys WHERE user_id = ? AND provider = ?',
  )
    .bind(user.uid, provider)
    .run();

  return c.json({ ok: true, removed: (result.meta?.changes ?? 0) > 0 });
});

keysRoutes.get('/keys/resolve/:provider', async (c) => {
  const user = await requireUser(c);
  const provider = c.req.param('provider');

  const row = await c.env.DB.prepare(
    'SELECT encrypted_key, iv FROM keys WHERE user_id = ? AND provider = ?',
  )
    .bind(user.uid, provider)
    .first<{ encrypted_key: string; iv: string }>();

  if (!row) return c.json({ key: null });

  const key = await decryptKey(row.encrypted_key, row.iv, c.env.SESSION_SIGNING_KEY);
  return c.json({ key });
});
