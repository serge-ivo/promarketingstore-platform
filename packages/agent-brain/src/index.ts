import { Hono } from 'hono';

interface Env {
  CAMPAIGN_AGENT: DurableObjectNamespace;
  DB: D1Database;
  PMS_API_BASE: string;
  INTERNAL_TOKEN?: string;
}

interface BrainState {
  campaignId: string;
  ownerId: string;
  status: 'idle' | 'planning' | 'needs_approval' | 'scheduled' | 'cancelled';
  updatedAt: number;
}

const app = new Hono<{ Bindings: Env }>();

function internalAuthorized(request: Request, env: Env): boolean {
  const expected = env.INTERNAL_TOKEN;
  if (!expected) return false;
  return request.headers.get('X-Internal-Token') === expected;
}

export class CampaignAgent {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (!internalAuthorized(request, this.env)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'pms-campaign-agent' });
    if (url.pathname === '/state' && request.method === 'GET') return this.getState();
    if (url.pathname === '/state' && request.method === 'PUT') return this.putState(request);
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  private async getState(): Promise<Response> {
    const brain = await this.state.storage.get<BrainState>('brain');
    return Response.json({ brain: brain ?? null });
  }

  private async putState(request: Request): Promise<Response> {
    const body = await request.json<Partial<BrainState>>();
    if (!body.campaignId || !body.ownerId) {
      return Response.json({ error: 'campaignId and ownerId are required' }, { status: 400 });
    }
    const brain: BrainState = {
      campaignId: body.campaignId,
      ownerId: body.ownerId,
      status: body.status ?? 'idle',
      updatedAt: Date.now(),
    };
    await this.state.storage.put('brain', brain);
    return Response.json({ brain });
  }
}

app.get('/', (c) => c.json({ ok: true, service: 'promarketingstore-agent-brain' }));
app.get('/health', (c) => c.json({ ok: true }));

app.all('/v1/campaigns/:campaignId/brain/*', async (c) => {
  if (!internalAuthorized(c.req.raw, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const campaignId = c.req.param('campaignId');
  const id = c.env.CAMPAIGN_AGENT.idFromName(campaignId);
  const stub = c.env.CAMPAIGN_AGENT.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/${c.req.path.split('/brain/')[1]}`;
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Internal-Token', c.env.INTERNAL_TOKEN ?? '');
  return stub.fetch(new Request(url, { method: c.req.method, headers, body: c.req.raw.body }));
});

export default app;
