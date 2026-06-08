/**
 * Auth middleware + JWT session helpers for ProMarketingStore.
 *
 * Session tokens are HMAC-SHA256 signed JWTs (body.sig format, same as PDS).
 * All PMS workers verify locally — no network round-trip.
 */

import type { Context, Next } from 'hono';
import type { Env } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SessionClaims {
  uid: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  iat: number;
  exp: number;
}

export type NewSession = Omit<SessionClaims, 'iat' | 'exp'>;

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// ── JWT primitives ───────────────────────────────────────────────────

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(s: string): string {
  return b64urlBytes(enc.encode(s));
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(data: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(signingKey) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data) as BufferSource);
  return b64urlBytes(new Uint8Array(sig));
}

// ── Session token mint / verify ──────────────────────────────────────

export async function createSession(
  claims: NewSession,
  signingKey: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, signingKey);
  return `${body}.${sig}`;
}

export async function verifySession(
  token: string,
  signingKey: string,
): Promise<SessionClaims | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = await hmac(body, signingKey);
    if (!timingSafeEqual(sig, expected)) return null;
    const claims = JSON.parse(b64urlDecode(body)) as SessionClaims;
    if (!claims.uid) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Hono middleware ──────────────────────────────────────────────────

/**
 * Hono middleware that requires a valid Bearer token. Sets `c.set('user', claims)`
 * on success; throws 401 on failure.
 */
export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: SessionClaims } }>, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError('missing bearer token', 401);
  }
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    throw new HttpError('invalid or expired session', 401);
  }
  c.set('user', claims);
  await next();
}

/**
 * Helper to extract verified claims from a Bearer token without middleware.
 * Throws 401 on failure. Use in route handlers that need the user inline.
 */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<SessionClaims> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError('missing bearer token', 401);
  }
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    throw new HttpError('invalid or expired session', 401);
  }
  return claims;
}

// ── Google OAuth token exchange ──────────────────────────────────────

interface GoogleProfile {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

export async function exchangeGoogleCode(
  code: string,
  env: Env,
): Promise<GoogleProfile | null> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI ?? `${env.CORS_ORIGIN}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return null;

  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return null;

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) return null;

  return (await infoRes.json()) as GoogleProfile;
}
