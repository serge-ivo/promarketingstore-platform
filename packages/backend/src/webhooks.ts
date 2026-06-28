import { Hono } from 'hono';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const webhookRoutes = new Hono<AppEnv>();

/**
 * Verify the webhook request by checking that the sourceId is a valid UUID.
 * The sourceId itself acts as a secret — it's a random UUID known only to the user
 * who configured it. This is sufficient for webhook endpoints that receive
 * low-sensitivity content (public channel messages).
 */
function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// POST /webhooks/slack/:sourceId — receive Slack messages
webhookRoutes.post('/webhooks/slack/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  if (!isValidUUID(sourceId)) return c.json({ ok: false }, 400);

  // Slack sends URL verification challenge on setup
  type SlackPayload = {
    type?: string;
    challenge?: string;
    event?: {
      type: string;
      text?: string;
      channel?: string;
      user?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
    };
  };
  const body: SlackPayload = await c.req.json<SlackPayload>().catch((): SlackPayload => ({}));

  if (body.type === 'url_verification' && body.challenge) {
    return c.text(body.challenge);
  }

  // Verify source exists and is active
  const source = await c.env.DB.prepare(
    "SELECT id, user_id, config FROM sources WHERE id = ? AND type = 'slack' AND status = 'active'",
  ).bind(sourceId).first<{ id: string; user_id: string; config: string }>();

  if (!source) return c.json({ ok: false }, 404);

  // Skip non-message events, bot messages, and thread replies
  if (body.event?.type !== 'message' || !body.event.text) return c.json({ ok: true });
  if (body.event.bot_id) return c.json({ ok: true });
  if (body.event.thread_ts && body.event.thread_ts !== body.event.ts) return c.json({ ok: true });

  const text = body.event.text;
  if (text.length < 20) return c.json({ ok: true });

  const hash = await contentHash(text);
  try {
    await c.env.DB.prepare(
      `INSERT INTO source_content (id, source_id, user_id, title, body, url, content_hash, extracted_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(), source.id, source.user_id,
      'Slack message', text, hash,
    ).run();
  } catch {
    // Duplicate — ignore
  }

  await c.env.DB.prepare(
    "UPDATE sources SET last_scanned_at = datetime('now') WHERE id = ?",
  ).bind(source.id).run();

  return c.json({ ok: true });
});

// POST /webhooks/teams/:sourceId — receive Teams messages (via Power Automate or webhook)
webhookRoutes.post('/webhooks/teams/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  if (!isValidUUID(sourceId)) return c.json({ ok: false }, 400);

  const source = await c.env.DB.prepare(
    "SELECT id, user_id, config FROM sources WHERE id = ? AND type = 'teams' AND status = 'active'",
  ).bind(sourceId).first<{ id: string; user_id: string; config: string }>();

  if (!source) return c.json({ ok: false }, 404);

  type TeamsPayload = {
    text?: string;
    title?: string;
    summary?: string;
    body?: { content?: string };
  };
  const body: TeamsPayload = await c.req.json<TeamsPayload>().catch((): TeamsPayload => ({}));

  const text = body.text || body.summary || body.body?.content;
  if (!text || text.length < 20) return c.json({ ok: true });

  const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hash = await contentHash(cleanText);

  try {
    await c.env.DB.prepare(
      `INSERT INTO source_content (id, source_id, user_id, title, body, url, content_hash, extracted_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, datetime('now'))`,
    ).bind(
      crypto.randomUUID(), source.id, source.user_id,
      body.title || 'Teams message', cleanText, hash,
    ).run();
  } catch {
    // Duplicate
  }

  await c.env.DB.prepare(
    "UPDATE sources SET last_scanned_at = datetime('now') WHERE id = ?",
  ).bind(source.id).run();

  return c.json({ ok: true });
});

async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
