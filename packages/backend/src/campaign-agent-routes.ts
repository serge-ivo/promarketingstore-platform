import type { Hono } from 'hono';
import { registerCampaignPostRoutes } from './campaign-post-routes.js';
import { registerCampaignRunRoutes } from './campaign-run-routes.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export function registerCampaignAgentRoutes(routes: Hono<AppEnv>) {
  registerCampaignRunRoutes(routes);
  registerCampaignPostRoutes(routes);
}
