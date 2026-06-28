import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { getOwnedCampaign } from './campaign-store.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const brainRoutes = new Hono<AppEnv>();

async function callBrain(env: Env, campaignId: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.AGENT_BRAIN) throw new HttpError('agent brain binding is not configured', 503);
  if (!env.INTERNAL_TOKEN) throw new HttpError('internal token is not configured', 503);

  const headers = new Headers(init.headers);
  headers.set('X-Internal-Token', env.INTERNAL_TOKEN);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  return env.AGENT_BRAIN.fetch(
    new Request(`https://agent-brain.internal/v1/campaigns/${encodeURIComponent(campaignId)}/brain/${path}`, {
      ...init,
      headers,
    }),
  );
}

brainRoutes.get('/campaigns/:id/brain', async (c) => {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, c.req.param('id'), user.uid);
  const response = await callBrain(c.env, campaign.id, 'state');
  return new Response(response.body, response);
});

brainRoutes.put('/campaigns/:id/brain', async (c) => {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, c.req.param('id'), user.uid);
  const body = await c.req
    .json<{ status?: 'idle' | 'planning' | 'needs_approval' | 'scheduled' | 'cancelled' }>()
    .catch((): { status?: 'idle' | 'planning' | 'needs_approval' | 'scheduled' | 'cancelled' } => ({}));

  const response = await callBrain(c.env, campaign.id, 'state', {
    method: 'PUT',
    body: JSON.stringify({
      campaignId: campaign.id,
      ownerId: user.uid,
      status: body.status ?? 'idle',
    }),
  });
  return new Response(response.body, response);
});
