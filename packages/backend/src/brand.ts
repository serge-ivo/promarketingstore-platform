import { Hono } from 'hono';
import { requireUser } from './auth.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const brandRoutes = new Hono<AppEnv>();

interface BrandRow {
  id: string;
  user_id: string;
  name: string;
  voice_json: string;
  audience_json: string;
  blocked_terms_json: string;
  approval_rules_json: string;
  created_at: string;
  updated_at: string;
}

function safeJson(s: string, fallback: unknown = {}): unknown {
  try { return JSON.parse(s); } catch { return fallback; }
}

function serializeBrand(row: BrandRow) {
  return {
    id: row.id,
    name: row.name,
    voice: safeJson(row.voice_json, {}),
    audience: safeJson(row.audience_json, {}),
    blockedTerms: safeJson(row.blocked_terms_json, []),
    approvalRules: safeJson(row.approval_rules_json, {}),
    createdAt: row.created_at,
  };
}

// GET /brand — get user's brand profile (creates default if none)
brandRoutes.get('/brand', async (c) => {
  const user = await requireUser(c);
  let row = await c.env.DB.prepare(
    'SELECT * FROM brand_profiles WHERE user_id = ? LIMIT 1',
  ).bind(user.uid).first<BrandRow>();

  if (!row) {
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO brand_profiles (id, user_id, name, voice_json, audience_json, blocked_terms_json, approval_rules_json, created_at, updated_at)
       VALUES (?, ?, 'My Brand', '{}', '{}', '[]', '{}', datetime('now'), datetime('now'))`,
    ).bind(id, user.uid).run();
    row = await c.env.DB.prepare('SELECT * FROM brand_profiles WHERE id = ?').bind(id).first<BrandRow>();
  }

  return c.json({ brand: row ? serializeBrand(row) : null });
});

// PATCH /brand — update brand profile
brandRoutes.patch('/brand', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    name?: string;
    voice?: { tone?: string; style?: string; examples?: string[] };
    audience?: { description?: string; demographics?: string };
    blockedTerms?: string[];
    approvalRules?: { autoApprove?: boolean; autoSchedule?: boolean; postsPerDay?: number };
  }>();

  let row = await c.env.DB.prepare(
    'SELECT id FROM brand_profiles WHERE user_id = ? LIMIT 1',
  ).bind(user.uid).first<{ id: string }>();

  if (!row) {
    row = { id: crypto.randomUUID() };
    await c.env.DB.prepare(
      `INSERT INTO brand_profiles (id, user_id, name, voice_json, audience_json, blocked_terms_json, approval_rules_json, created_at, updated_at)
       VALUES (?, ?, 'My Brand', '{}', '{}', '[]', '{}', datetime('now'), datetime('now'))`,
    ).bind(row.id, user.uid).run();
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.voice !== undefined) { sets.push('voice_json = ?'); params.push(JSON.stringify(body.voice)); }
  if (body.audience !== undefined) { sets.push('audience_json = ?'); params.push(JSON.stringify(body.audience)); }
  if (body.blockedTerms !== undefined) { sets.push('blocked_terms_json = ?'); params.push(JSON.stringify(body.blockedTerms)); }
  if (body.approvalRules !== undefined) { sets.push('approval_rules_json = ?'); params.push(JSON.stringify(body.approvalRules)); }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(row.id);
    await c.env.DB.prepare(
      `UPDATE brand_profiles SET ${sets.join(', ')} WHERE id = ?`,
    ).bind(...params).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM brand_profiles WHERE id = ?').bind(row.id).first<BrandRow>();
  return c.json({ brand: updated ? serializeBrand(updated) : null });
});

/** Load brand voice for AI generation context. */
export async function loadBrandVoice(env: Env, userId: string): Promise<{
  tone?: string;
  audience?: string;
  hashtags?: string[];
  avoidTopics?: string[];
  examples?: string[];
} | null> {
  const row = await env.DB.prepare(
    'SELECT voice_json, audience_json, blocked_terms_json FROM brand_profiles WHERE user_id = ? LIMIT 1',
  ).bind(userId).first<{ voice_json: string; audience_json: string; blocked_terms_json: string }>();

  if (!row) return null;

  const voice = safeJson(row.voice_json, {}) as { tone?: string; style?: string; examples?: string[] };
  const audience = safeJson(row.audience_json, {}) as { description?: string };
  const blocked = safeJson(row.blocked_terms_json, []) as string[];

  return {
    tone: voice.tone || voice.style,
    audience: audience.description,
    examples: voice.examples,
    avoidTopics: blocked.length > 0 ? blocked : undefined,
  };
}
