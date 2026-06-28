export interface Env {
  DB: D1Database;
  /** R2 bucket for media uploads (images, videos). */
  MEDIA?: R2Bucket;
  /** KV namespace for rate limits, PKCE verifiers, ephemeral state. */
  KV?: KVNamespace;
  /** Service binding to the CampaignAgent Durable Object Worker. */
  AGENT_BRAIN?: Fetcher;
  /** Shared secret for backend -> internal Worker calls. */
  INTERNAL_TOKEN?: string;
  /** Separate AES-GCM key material for OAuth/social account tokens. */
  SOCIAL_TOKEN_ENCRYPTION_KEY: string;
  /** Meta/Facebook app credentials for organic publishing OAuth. */
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_REDIRECT_URI?: string;
  META_GRAPH_VERSION?: string;
  /** X (Twitter) OAuth 2.0 credentials. */
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  X_REDIRECT_URI?: string;
  /** Signs + verifies PMS session JWTs. */
  SESSION_SIGNING_KEY: string;
  /** Google OAuth credentials. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Optional override for the Google OAuth redirect URI. Defaults to CORS_ORIGIN/auth/callback. */
  GOOGLE_REDIRECT_URI?: string;
  /** Allowed CORS origin. */
  CORS_ORIGIN: string;
}
