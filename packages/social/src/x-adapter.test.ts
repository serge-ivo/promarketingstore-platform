import { afterEach, describe, expect, it, vi } from 'vitest';
import { XAdapter } from './x-adapter.js';
import type { PublishInput, SocialAccountRef } from './index.js';

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeInput(overrides: Partial<PublishInput> = {}): PublishInput {
  const account: SocialAccountRef = {
    id: 'acct_1',
    provider: 'x',
    accountId: 'user_1',
    displayName: '@testuser',
    accessToken: 'test-token',
  };
  return {
    postId: 'post_1',
    provider: 'x',
    account,
    postType: 'text',
    body: 'Hello from PMS!',
    idempotencyKey: 'idem_1',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('XAdapter', () => {
  it('publishes a text tweet', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { id: '1234567890', text: 'Hello from PMS!' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new XAdapter();
    const result = await adapter.publish(makeInput());

    expect(result.provider).toBe('x');
    expect(result.externalPostId).toBe('1234567890');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.x.com/2/tweets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );

    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const callBody = JSON.parse(callArgs[1].body as string);
    expect(callBody.text).toBe('Hello from PMS!');
    expect(callBody.media).toBeUndefined();
  });

  it('throws on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ errors: [{ message: 'Rate limit exceeded' }] }, { status: 429 }),
      ),
    );

    const adapter = new XAdapter();
    await expect(adapter.publish(makeInput())).rejects.toThrow('Rate limit exceeded');
  });

  it('rejects non-x provider', async () => {
    const adapter = new XAdapter();
    await expect(adapter.publish(makeInput({ provider: 'facebook' }))).rejects.toThrow(
      'XAdapter cannot publish provider: facebook',
    );
  });

  it('validates x connection', async () => {
    const adapter = new XAdapter();
    const result = await adapter.validateConnection({
      id: 'a1',
      provider: 'x',
      accountId: '123',
      displayName: '@test',
      accessToken: 'tok',
    });
    expect(result.ok).toBe(true);
    expect(result.capabilities).toContain('text');
    expect(result.capabilities).toContain('image');
  });

  it('rejects non-x connection validation', async () => {
    const adapter = new XAdapter();
    const result = await adapter.validateConnection({
      id: 'a1',
      provider: 'facebook',
      accountId: '123',
      displayName: 'Page',
      accessToken: 'tok',
    });
    expect(result.ok).toBe(false);
  });
});
