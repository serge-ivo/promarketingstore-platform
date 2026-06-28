export type SocialProvider = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'tiktok' | 'email';

export interface SocialAccountRef {
  id: string;
  provider: SocialProvider;
  accountId: string;
  pageId?: string | null;
  displayName: string;
  accessToken: string;
}

export interface PublishInput {
  postId: string;
  provider: SocialProvider;
  account: SocialAccountRef;
  postType: 'text' | 'image' | 'link';
  body: string;
  mediaUrl?: string | null;
  linkUrl?: string | null;
  idempotencyKey: string;
}

export interface PublishResult {
  provider: SocialProvider;
  externalPostId: string;
  externalPermalink?: string | null;
  rawResponse: unknown;
}

export interface MetricsInput {
  provider: SocialProvider;
  account: SocialAccountRef;
  externalPostId: string;
}

export interface MetricsResult {
  provider: SocialProvider;
  metrics: Record<string, number | string | null>;
  rawResponse: unknown;
}

export interface ConnectionStatus {
  ok: boolean;
  provider: SocialProvider;
  accountId: string;
  capabilities: Array<'text' | 'image' | 'link' | 'metrics'>;
  error?: string;
}

export interface SocialProviderAdapter {
  publish(input: PublishInput): Promise<PublishResult>;
  getMetrics(input: MetricsInput): Promise<MetricsResult>;
  validateConnection(account: SocialAccountRef): Promise<ConnectionStatus>;
}

export class UnsupportedSocialOperation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSocialOperation';
  }
}

export { XAdapter } from './x-adapter.js';

export class MetaOrganicAdapter implements SocialProviderAdapter {
  constructor(private readonly graphBase = 'https://graph.facebook.com/v20.0') {}

  async publish(input: PublishInput): Promise<PublishResult> {
    if (input.provider === 'facebook') return this.publishFacebook(input);
    if (input.provider === 'instagram') return this.publishInstagram(input);
    throw new UnsupportedSocialOperation(`Meta adapter cannot publish provider: ${input.provider}`);
  }

  async getMetrics(input: MetricsInput): Promise<MetricsResult> {
    return {
      provider: input.provider,
      metrics: {},
      rawResponse: { deferred: 'metrics adapter not implemented yet', externalPostId: input.externalPostId },
    };
  }

  async validateConnection(account: SocialAccountRef): Promise<ConnectionStatus> {
    if (account.provider !== 'facebook' && account.provider !== 'instagram') {
      return {
        ok: false,
        provider: account.provider,
        accountId: account.accountId,
        capabilities: [],
        error: 'Meta adapter only supports Facebook and Instagram accounts',
      };
    }

    return {
      ok: true,
      provider: account.provider,
      accountId: account.accountId,
      capabilities: account.provider === 'facebook' ? ['text', 'image', 'link', 'metrics'] : ['image', 'metrics'],
    };
  }

  private async publishFacebook(input: PublishInput): Promise<PublishResult> {
    if (input.postType !== 'text' && input.postType !== 'link') {
      throw new UnsupportedSocialOperation(
        'Facebook MVP supports text/link posts; image upload lands with media pipeline',
      );
    }

    const endpoint = `${this.graphBase}/${encodeURIComponent(input.account.accountId)}/feed`;
    const body = new URLSearchParams({
      message: input.body,
      access_token: input.account.accessToken,
    });
    if (input.linkUrl) body.set('link', input.linkUrl);

    const response = await fetch(endpoint, { method: 'POST', body });
    const raw = (await response.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!response.ok || !raw.id) {
      throw new Error(raw.error?.message ?? `Facebook publish failed with ${response.status}`);
    }

    return {
      provider: 'facebook',
      externalPostId: raw.id,
      externalPermalink: null,
      rawResponse: raw,
    };
  }

  private async publishInstagram(input: PublishInput): Promise<PublishResult> {
    if (input.postType !== 'image' || !input.mediaUrl) {
      throw new UnsupportedSocialOperation('Instagram MVP requires an image mediaUrl');
    }

    const containerEndpoint = `${this.graphBase}/${encodeURIComponent(input.account.accountId)}/media`;
    const containerBody = new URLSearchParams({
      image_url: input.mediaUrl,
      caption: input.body,
      access_token: input.account.accessToken,
    });
    const containerResponse = await fetch(containerEndpoint, { method: 'POST', body: containerBody });
    const container = (await containerResponse.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!containerResponse.ok || !container.id) {
      throw new Error(container.error?.message ?? `Instagram media container failed with ${containerResponse.status}`);
    }

    const publishEndpoint = `${this.graphBase}/${encodeURIComponent(input.account.accountId)}/media_publish`;
    const publishBody = new URLSearchParams({
      creation_id: container.id,
      access_token: input.account.accessToken,
    });
    const publishResponse = await fetch(publishEndpoint, { method: 'POST', body: publishBody });
    const published = (await publishResponse.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!publishResponse.ok || !published.id) {
      throw new Error(published.error?.message ?? `Instagram publish failed with ${publishResponse.status}`);
    }

    return {
      provider: 'instagram',
      externalPostId: published.id,
      externalPermalink: null,
      rawResponse: { container, published },
    };
  }
}
