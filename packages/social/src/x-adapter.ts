import type {
  ConnectionStatus,
  MetricsInput,
  MetricsResult,
  PublishInput,
  PublishResult,
  SocialAccountRef,
  SocialProviderAdapter,
} from './index.js';

export class XAdapter implements SocialProviderAdapter {
  async publish(input: PublishInput): Promise<PublishResult> {
    if (input.provider !== 'x') {
      throw new Error(`XAdapter cannot publish provider: ${input.provider}`);
    }

    let mediaIds: string[] = [];
    if (input.mediaUrl && input.postType === 'image') {
      const mediaId = await this.uploadMediaFromUrl(input.account.accessToken, input.mediaUrl);
      mediaIds = [mediaId];
    }

    const body: Record<string, unknown> = { text: input.body };
    if (mediaIds.length > 0) {
      body.media = { media_ids: mediaIds };
    }

    const res = await fetch('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = (await res.json().catch(() => ({}))) as {
      data?: { id: string; text?: string };
      errors?: Array<{ message: string }>;
    };
    if (!res.ok || !raw.data?.id) {
      const msg = raw.errors?.[0]?.message ?? `X publish failed with ${res.status}`;
      throw new Error(msg);
    }

    return {
      provider: 'x',
      externalPostId: raw.data.id,
      externalPermalink: null,
      rawResponse: raw,
    };
  }

  async getMetrics(input: MetricsInput): Promise<MetricsResult> {
    return {
      provider: input.provider,
      metrics: {},
      rawResponse: { deferred: 'X metrics not implemented yet', externalPostId: input.externalPostId },
    };
  }

  async validateConnection(account: SocialAccountRef): Promise<ConnectionStatus> {
    if (account.provider !== 'x') {
      return {
        ok: false,
        provider: account.provider,
        accountId: account.accountId,
        capabilities: [],
        error: 'XAdapter only supports X accounts',
      };
    }
    return {
      ok: true,
      provider: 'x',
      accountId: account.accountId,
      capabilities: ['text', 'image', 'link'],
    };
  }

  private async uploadMediaFromUrl(token: string, mediaUrl: string): Promise<string> {
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to fetch media from ${mediaUrl}`);
    const buffer = await mediaRes.arrayBuffer();

    const formData = new FormData();
    formData.append('media', new Blob([buffer]), 'upload');
    formData.append('media_category', 'tweet_image');

    // X v1.1 media upload (v2 media upload endpoint is not available yet)
    const res = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = (await res.json().catch(() => ({}))) as { media_id_string?: string };
    if (!res.ok || !data.media_id_string) {
      throw new Error(`X media upload failed with ${res.status}`);
    }
    return data.media_id_string;
  }
}
