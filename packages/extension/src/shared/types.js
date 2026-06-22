// Shared types for extension messaging
// Action: { type: 'post', platform: 'facebook'|'x'|'instagram'|'tiktok', media?: {url, blob}, caption: string }
// Response: { ok: boolean, link?: string, error?: string }

export const PLATFORMS = ['facebook', 'x', 'instagram', 'tiktok'];

export const MSG = {
  POST: 'pms:post',
  POST_RESULT: 'pms:post:result',
  STATUS: 'pms:status',
  STATUS_RESULT: 'pms:status:result',
};
