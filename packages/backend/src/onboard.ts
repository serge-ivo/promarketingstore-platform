import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { loadBrandVoice } from './brand.js';
import { generatePosts } from './generator.js';
import { scanSource } from './scanner.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const onboardRoutes = new Hono<AppEnv>();

/**
 * POST /onboard — one-click onboarding.
 * Takes a URL, scans it, generates social posts, returns drafts.
 * This is the "aha moment" — user sees real posts from their content in seconds.
 */
onboardRoutes.post('/onboard', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    url: string;
    platforms?: string[];
    count?: number;
  }>();

  if (!body.url) return c.json({ error: 'url is required' }, 400);

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid');
  } catch {
    return c.json({ error: 'invalid URL' }, 400);
  }

  const platforms = (body.platforms || ['x', 'facebook']).filter(p =>
    ['x', 'facebook', 'instagram'].includes(p),
  );
  const count = Math.min(body.count || 5, 15);

  // Step 1: Create or find source (upsert to avoid race condition)
  const sourceId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO sources (id, user_id, type, name, config, scan_frequency, status, created_at, updated_at)
     VALUES (?, ?, 'website', ?, ?, 'daily', 'active', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    sourceId, user.uid,
    parsedUrl.hostname,
    JSON.stringify({ url: body.url }),
  ).run();

  // Check if a source for this origin already existed
  const existingSource = await c.env.DB.prepare(
    "SELECT id FROM sources WHERE user_id = ? AND type = 'website' AND json_extract(config, '$.url') LIKE ? LIMIT 1",
  ).bind(user.uid, `${parsedUrl.origin}%`).first<{ id: string }>();
  const resolvedSourceId = existingSource?.id ?? sourceId;

  // Step 2: Scan
  const source = await c.env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(resolvedSourceId)
    .first<{ id: string; user_id: string; type: string; config: string }>();
  if (!source) throw new HttpError('source creation failed', 500);

  let scanResult: { extracted: number; skipped: number };
  try {
    scanResult = await scanSource(c.env, source);
  } catch (err) {
    return c.json({
      error: `Failed to scan ${parsedUrl.hostname}: ${err instanceof Error ? err.message : 'fetch failed'}`,
      sourceId: resolvedSourceId,
    }, 502);
  }

  await c.env.DB.prepare(
    "UPDATE sources SET last_scanned_at = datetime('now') WHERE id = ?",
  ).bind(resolvedSourceId).run();

  // Step 3: Load source content
  const contentRows = await c.env.DB.prepare(
    'SELECT id, title, body, url FROM source_content WHERE source_id = ? ORDER BY extracted_at DESC LIMIT 10',
  ).bind(resolvedSourceId).all<{ id: string; title: string | null; body: string; url: string | null }>();

  if (!contentRows.results.length) {
    return c.json({
      sourceId: resolvedSourceId,
      scanned: scanResult,
      generated: 0,
      posts: [],
      message: 'No substantial content found on this page. Try a blog or about page.',
    });
  }

  // Step 4: Generate posts
  const brandVoice = await loadBrandVoice(c.env, user.uid);
  let posts: Array<{ id: string; platform: string; content: string; sourceContentId: string; status: string }>;
  try {
    posts = await generatePosts(c.env, {
      userId: user.uid,
      sourceContent: contentRows.results,
      platforms,
      count,
      tone: brandVoice?.tone || 'professional',
      brandVoice: brandVoice ?? undefined,
    });
  } catch (err) {
    // AI key missing or API error — return scan results without posts
    return c.json({
      sourceId: resolvedSourceId,
      scanned: scanResult,
      generated: 0,
      posts: [],
      contentItems: contentRows.results.length,
      error: err instanceof Error ? err.message : 'generation failed',
      hint: 'Add your OpenAI or Anthropic API key in Settings to generate posts.',
    });
  }

  return c.json({
    sourceId: resolvedSourceId,
    scanned: scanResult,
    generated: posts.length,
    posts: posts.map(p => ({
      id: p.id,
      platform: p.platform,
      content: p.content,
      status: p.status,
    })),
  });
});
