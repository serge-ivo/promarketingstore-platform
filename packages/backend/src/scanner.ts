import type { Env } from './types.js';

interface SourceRow {
  id: string;
  user_id: string;
  type: string;
  config: string;
}

interface ScanResult {
  extracted: number;
  skipped: number;
  items: Array<{ title: string | null; bodyPreview: string }>;
}

export async function scanSource(env: Env, source: SourceRow): Promise<ScanResult> {
  const config = JSON.parse(source.config) as Record<string, string>;

  switch (source.type) {
    case 'website':
      return scanWebsite(env, source, config.url);
    case 'rss':
      return scanRss(env, source, config.url);
    default:
      return { extracted: 0, skipped: 0, items: [] };
  }
}

async function scanWebsite(env: Env, source: SourceRow, url: string): Promise<ScanResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'PMS-Scanner/1.0 (content extraction)' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  // Limit response size to 2MB to prevent memory issues
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  if (contentLength > 2 * 1024 * 1024) throw new Error('Page too large (>2MB)');

  const html = (await res.text()).slice(0, 2 * 1024 * 1024);
  const sections = extractSections(html, url);

  let extracted = 0;
  let skipped = 0;
  const items: Array<{ title: string | null; bodyPreview: string }> = [];

  for (const section of sections) {
    if (section.body.length < 50) { skipped++; continue; }

    const hash = await contentHash(section.body);
    try {
      await env.DB.prepare(
        `INSERT INTO source_content (id, source_id, user_id, title, body, url, content_hash, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(
        crypto.randomUUID(), source.id, source.user_id,
        section.title, section.body, section.url || url, hash,
      ).run();
      extracted++;
      items.push({ title: section.title, bodyPreview: section.body.slice(0, 200) });
    } catch {
      // UNIQUE constraint = duplicate, skip
      skipped++;
    }
  }

  return { extracted, skipped, items };
}

async function scanRss(env: Env, source: SourceRow, url: string): Promise<ScanResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'PMS-Scanner/1.0 (RSS reader)' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Failed to fetch RSS ${url}: ${res.status}`);

  const xml = (await res.text()).slice(0, 2 * 1024 * 1024);
  const entries = parseRssItems(xml);

  let extracted = 0;
  let skipped = 0;
  const items: Array<{ title: string | null; bodyPreview: string }> = [];

  for (const entry of entries.slice(0, 20)) {
    if (entry.body.length < 30) { skipped++; continue; }

    const hash = await contentHash(entry.body);
    try {
      await env.DB.prepare(
        `INSERT INTO source_content (id, source_id, user_id, title, body, url, content_hash, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(
        crypto.randomUUID(), source.id, source.user_id,
        entry.title, entry.body, entry.url, hash,
      ).run();
      extracted++;
      items.push({ title: entry.title, bodyPreview: entry.body.slice(0, 200) });
    } catch {
      skipped++;
    }
  }

  return { extracted, skipped, items };
}

/** Extract readable text sections from HTML. */
function extractSections(html: string, baseUrl: string): Array<{ title: string | null; body: string; url: string | null }> {
  // Strip script, style, nav, header, footer tags
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Extract page title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const pageTitle = titleMatch ? decodeEntities(titleMatch[1].trim()) : null;

  // Extract meta description
  const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i);
  const metaDesc = metaMatch ? decodeEntities(metaMatch[1].trim()) : null;

  // Extract headings and their following content
  const sections: Array<{ title: string | null; body: string; url: string | null }> = [];

  // Add meta description as a section if substantial
  if (metaDesc && metaDesc.length > 30) {
    sections.push({ title: pageTitle, body: metaDesc, url: baseUrl });
  }

  // Split by headings (h1-h3) and extract text blocks
  const headingBlocks = text.split(/<h[1-3][^>]*>/i);
  for (const block of headingBlocks) {
    const headingEnd = block.indexOf('</h');
    let heading: string | null = null;
    let content = block;

    if (headingEnd > 0) {
      heading = stripTags(block.slice(0, headingEnd)).trim();
      content = block.slice(headingEnd);
    }

    const cleaned = stripTags(content).trim();
    // Split into paragraphs, take substantial ones
    const paragraphs = cleaned.split(/\n\s*\n/).filter(p => p.trim().length > 60);

    for (const para of paragraphs.slice(0, 3)) {
      sections.push({
        title: heading || pageTitle,
        body: para.trim().slice(0, 2000),
        url: baseUrl,
      });
    }
  }

  // If we got nothing from headings, just grab the full body text
  if (sections.length === 0) {
    const fullText = stripTags(text).trim();
    if (fullText.length > 50) {
      // Split into ~500 char chunks
      for (let i = 0; i < fullText.length && sections.length < 10; i += 500) {
        const chunk = fullText.slice(i, i + 500).trim();
        if (chunk.length > 50) {
          sections.push({ title: pageTitle, body: chunk, url: baseUrl });
        }
      }
    }
  }

  return sections.slice(0, 15);
}

/** Minimal RSS/Atom parser — extracts title, description, link from items. */
function parseRssItems(xml: string): Array<{ title: string | null; body: string; url: string | null }> {
  const items: Array<{ title: string | null; body: string; url: string | null }> = [];

  // RSS 2.0 <item> or Atom <entry>
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  for (const match of xml.matchAll(itemRegex)) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const desc = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');

    if (desc) {
      items.push({
        title: title ? decodeEntities(stripTags(title).trim()) : null,
        body: decodeEntities(stripTags(desc).trim()).slice(0, 2000),
        url: link ? decodeEntities(link.trim()) : null,
      });
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1];

  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'is');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
