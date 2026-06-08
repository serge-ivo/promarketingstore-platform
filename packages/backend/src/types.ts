export interface Env {
  DB: D1Database;
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
