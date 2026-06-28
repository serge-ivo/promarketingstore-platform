import { HttpError } from './auth.js';
import { decryptKey } from './keys.js';
import type { Env } from './types.js';

interface SourceContentItem {
  id: string;
  title: string | null;
  body: string;
  url: string | null;
}

interface BrandVoice {
  tone?: string;
  audience?: string;
  hashtags?: string[];
  avoidTopics?: string[];
  examples?: string[];
}

interface GenerateInput {
  userId: string;
  sourceContent: SourceContentItem[];
  platforms: string[];
  count: number;
  tone: string;
  brandVoice?: BrandVoice;
}

interface GeneratedPost {
  id: string;
  platform: string;
  content: string;
  sourceContentId: string;
  status: string;
}

const PLATFORM_GUIDELINES: Record<string, string> = {
  x: 'X/Twitter: max 280 characters. Punchy, conversational. Use 1-2 relevant hashtags max. No fluff.',
  facebook: 'Facebook: 1-3 short paragraphs. Can be slightly longer. Ask a question to drive engagement. Emojis OK sparingly.',
  instagram: 'Instagram: Caption style. Lead with a hook. Use 3-5 relevant hashtags at the end. Emoji-friendly.',
};

/** Resolve user's AI API key from the vault. Tries OpenAI first, then Anthropic. */
async function resolveAiKey(
  env: Env,
  userId: string,
): Promise<{ provider: 'openai' | 'anthropic'; apiKey: string }> {
  for (const provider of ['openai', 'anthropic'] as const) {
    const row = await env.DB.prepare(
      'SELECT encrypted_key, iv FROM keys WHERE user_id = ? AND provider = ?',
    ).bind(userId, provider).first<{ encrypted_key: string; iv: string }>();

    if (row) {
      const apiKey = await decryptKey(row.encrypted_key, row.iv, env.SESSION_SIGNING_KEY);
      return { provider, apiKey };
    }
  }
  throw new HttpError('No AI API key found. Add your OpenAI or Anthropic key in Settings → API Keys.', 402);
}

async function callOpenAI(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(data.error?.message ?? `OpenAI API error ${res.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(data.error?.message ?? `Anthropic API error ${res.status}`);
  return data.content?.[0]?.text ?? '';
}

export async function generatePosts(
  env: Env,
  input: GenerateInput,
): Promise<GeneratedPost[]> {
  const contentContext = input.sourceContent
    .map((c, i) => `[Source ${i + 1}]${c.title ? ` "${c.title}"` : ''}\n${c.body.slice(0, 800)}${c.url ? `\nURL: ${c.url}` : ''}`)
    .join('\n\n');

  const platformGuides = input.platforms
    .map(p => PLATFORM_GUIDELINES[p] || `${p}: standard social media post format.`)
    .join('\n');

  let brandContext = '';
  if (input.brandVoice) {
    const bv = input.brandVoice;
    const parts: string[] = [];
    if (bv.tone) parts.push(`Brand tone: ${bv.tone}`);
    if (bv.audience) parts.push(`Target audience: ${bv.audience}`);
    if (bv.hashtags?.length) parts.push(`Preferred hashtags: ${bv.hashtags.join(', ')}`);
    if (bv.avoidTopics?.length) parts.push(`Avoid these topics: ${bv.avoidTopics.join(', ')}`);
    if (bv.examples?.length) parts.push(`Example posts for reference:\n${bv.examples.join('\n')}`);
    brandContext = parts.join('\n');
  }

  const systemPrompt = `You are a social media content creator. Generate engaging social media posts based on the source content provided.

Rules:
- Each post must be original and self-contained
- Adapt the content for each platform's format and audience
- Tone: ${input.tone}
- Include the source URL when relevant (especially for X and Facebook)
- Never fabricate facts — only use information from the source content
- Do NOT use markdown formatting — plain text only
${brandContext ? `\nBrand guidelines:\n${brandContext}` : ''}

Platform guidelines:
${platformGuides}`;

  const userPrompt = `Based on this content, generate ${input.count} social media posts (across these platforms: ${input.platforms.join(', ')}).

Source content:
${contentContext}

Return EXACTLY a JSON array of objects with these fields:
- "platform": one of ${JSON.stringify(input.platforms)}
- "content": the post text
- "sourceIndex": which source (1-based) this post is based on

Return only the JSON array, no other text.`;

  let postsData: Array<{ platform: string; content: string; sourceIndex: number }>;

  try {
    const { provider, apiKey } = await resolveAiKey(env, input.userId);
    const text = provider === 'openai'
      ? await callOpenAI(apiKey, systemPrompt, userPrompt)
      : await callAnthropic(apiKey, systemPrompt, userPrompt);
    postsData = parseJsonArray(text);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(`AI generation failed: ${err instanceof Error ? err.message : 'unknown error'}`, 502);
  }

  // Store as draft posts
  const result: GeneratedPost[] = [];
  for (const post of postsData) {
    if (!post.content || !post.platform) continue;
    if (!input.platforms.includes(post.platform)) continue;

    const sourceItem = input.sourceContent[Math.max(0, (post.sourceIndex || 1) - 1)];
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO posts (id, user_id, platform, content, status, source_content_id, caption_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, datetime('now'), datetime('now'))`,
    ).bind(
      id,
      input.userId,
      post.platform,
      post.content,
      sourceItem?.id ?? null,
      await captionHash(post.content),
    ).run();

    result.push({
      id,
      platform: post.platform,
      content: post.content,
      sourceContentId: sourceItem?.id ?? '',
      status: 'draft',
    });
  }

  return result;
}

function parseJsonArray(text: string): Array<{ platform: string; content: string; sourceIndex: number }> {
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    console.error('AI response contained no JSON array:', text.slice(0, 200));
    return [];
  }
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.error('Failed to parse AI JSON response:', text.slice(0, 200), err);
    return [];
  }
}

async function captionHash(caption: string): Promise<string> {
  const data = new TextEncoder().encode(caption.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
