import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const sourcesRoutes = new Hono<AppEnv>();

interface SourceRow {
  id: string;
  user_id: string;
  type: string;
  name: string;
  config: string;
  last_scanned_at: string | null;
  scan_frequency: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function serializeSource(row: SourceRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: JSON.parse(row.config),
    lastScannedAt: row.last_scanned_at,
    scanFrequency: row.scan_frequency,
    status: row.status,
    createdAt: row.created_at,
  };
}

// GET /sources — list user's content sources
sourcesRoutes.get('/sources', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM sources WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(user.uid).all<SourceRow>();
  return c.json({ sources: rows.results.map(serializeSource) });
});

// POST /sources — add a content source
sourcesRoutes.post('/sources', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    type: string;
    name: string;
    config: Record<string, string>;
    scanFrequency?: string;
  }>();

  const validTypes = ['website', 'rss', 'slack', 'teams'];
  if (!validTypes.includes(body.type)) {
    return c.json({ error: `type must be one of: ${validTypes.join(', ')}` }, 400);
  }
  if (!body.name) return c.json({ error: 'name is required' }, 400);

  if (body.type === 'website' && !body.config?.url) {
    return c.json({ error: 'config.url is required for website sources' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO sources (id, user_id, type, name, config, scan_frequency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
  ).bind(
    id, user.uid, body.type, body.name,
    JSON.stringify(body.config),
    body.scanFrequency || 'daily',
  ).run();

  const row = await c.env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>();
  return c.json({ source: row ? serializeSource(row) : null }, 201);
});

// DELETE /sources/:id
sourcesRoutes.delete('/sources/:id', async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(
    'SELECT id FROM sources WHERE id = ? AND user_id = ?',
  ).bind(c.req.param('id'), user.uid).first<{ id: string }>();
  if (!row) throw new HttpError('source not found', 404);

  await c.env.DB.prepare('DELETE FROM source_content WHERE source_id = ?').bind(row.id).run();
  await c.env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

// POST /sources/:id/scan — trigger a scan now
sourcesRoutes.post('/sources/:id/scan', async (c) => {
  const user = await requireUser(c);
  const source = await c.env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?',
  ).bind(c.req.param('id'), user.uid).first<SourceRow>();
  if (!source) throw new HttpError('source not found', 404);

  const { scanSource } = await import('./scanner.js');
  const result = await scanSource(c.env, source);

  await c.env.DB.prepare(
    "UPDATE sources SET last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).bind(source.id).run();

  return c.json(result);
});

// GET /sources/:id/content — list extracted content
sourcesRoutes.get('/sources/:id/content', async (c) => {
  const user = await requireUser(c);
  const source = await c.env.DB.prepare(
    'SELECT id FROM sources WHERE id = ? AND user_id = ?',
  ).bind(c.req.param('id'), user.uid).first<{ id: string }>();
  if (!source) throw new HttpError('source not found', 404);

  const rows = await c.env.DB.prepare(
    `SELECT id, title, body, url, extracted_at FROM source_content
     WHERE source_id = ? ORDER BY extracted_at DESC LIMIT 50`,
  ).bind(source.id).all<{ id: string; title: string | null; body: string; url: string | null; extracted_at: string }>();

  return c.json({
    content: rows.results.map(r => ({
      id: r.id,
      title: r.title,
      body: r.body.slice(0, 500),
      url: r.url,
      extractedAt: r.extracted_at,
    })),
  });
});

// POST /sources/:id/generate — generate social posts from source content
sourcesRoutes.post('/sources/:id/generate', async (c) => {
  const user = await requireUser(c);
  const source = await c.env.DB.prepare(
    'SELECT * FROM sources WHERE id = ? AND user_id = ?',
  ).bind(c.req.param('id'), user.uid).first<SourceRow>();
  if (!source) throw new HttpError('source not found', 404);

  const body = await c.req.json<{
    platforms?: string[];
    count?: number;
    tone?: string;
    contentIds?: string[];
  }>().catch((): { platforms?: string[]; count?: number; tone?: string; contentIds?: string[] } => ({}));

  const platforms = body.platforms || ['x', 'facebook'];
  const count = Math.min(body.count || 5, 20);
  const tone = body.tone || 'professional';

  // Get recent source content
  let contentSql = `SELECT id, title, body, url FROM source_content WHERE source_id = ? AND user_id = ?`;
  const params: unknown[] = [source.id, user.uid];
  if (body.contentIds?.length) {
    const placeholders = body.contentIds.map(() => '?').join(',');
    contentSql += ` AND id IN (${placeholders})`;
    params.push(...body.contentIds);
  }
  contentSql += ' ORDER BY extracted_at DESC LIMIT 10';

  const contentRows = await c.env.DB.prepare(contentSql).bind(...params)
    .all<{ id: string; title: string | null; body: string; url: string | null }>();

  if (!contentRows.results.length) {
    return c.json({ error: 'no source content found — scan the source first' }, 400);
  }

  const { generatePosts } = await import('./generator.js');
  const { loadBrandVoice } = await import('./brand.js');
  const brandVoice = await loadBrandVoice(c.env, user.uid);

  const posts = await generatePosts(c.env, {
    userId: user.uid,
    sourceContent: contentRows.results,
    platforms,
    count,
    tone: brandVoice?.tone || tone,
    brandVoice: brandVoice ?? undefined,
  });

  return c.json({ generated: posts.length, posts });
});
