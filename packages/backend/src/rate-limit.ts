import type { Env } from './types.js';

const DAILY_LIMITS: Record<string, number> = {
  instagram: 25,
  facebook: 25,
  x: 50,
};

export async function checkRateLimit(
  env: Env,
  userId: string,
  platform: string,
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limit = DAILY_LIMITS[platform] ?? 25;
  if (!env.KV) return { allowed: true, remaining: limit, limit };

  const today = new Date().toISOString().slice(0, 10);
  const key = `ratelimit:${userId}:${platform}:${today}`;
  const count = parseInt((await env.KV.get(key)) || '0', 10);

  return { allowed: count < limit, remaining: Math.max(0, limit - count), limit };
}

export async function incrementRateLimit(env: Env, userId: string, platform: string): Promise<void> {
  if (!env.KV) return;

  const today = new Date().toISOString().slice(0, 10);
  const key = `ratelimit:${userId}:${platform}:${today}`;
  const count = parseInt((await env.KV.get(key)) || '0', 10);
  await env.KV.put(key, String(count + 1), { expirationTtl: 86400 });
}
