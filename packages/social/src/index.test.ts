import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaOrganicAdapter } from './index.js';

describe('MetaOrganicAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes Facebook posts through the configured Graph API base', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ id: 'page_123_post_456' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MetaOrganicAdapter('https://graph.facebook.com/v25.0');
    const result = await adapter.publish({
      postId: 'post_1',
      provider: 'facebook',
      account: {
        id: 'acct_1',
        provider: 'facebook',
        accountId: 'page_123',
        displayName: 'Page',
        accessToken: 'page-token',
      },
      postType: 'text',
      body: 'Launch update',
      idempotencyKey: 'post_1',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://graph.facebook.com/v25.0/page_123/feed');
    expect(result.externalPostId).toBe('page_123_post_456');
  });
});
