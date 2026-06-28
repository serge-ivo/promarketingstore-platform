export interface CampaignPlanningInput {
  name: string;
  goal: string | null;
  audience: string | null;
  channels: string;
}

export interface CampaignPlan {
  summary: string;
  channels: string[];
  audience: string;
  themes: string[];
  cadence: string;
  approvalMode: 'approve_first';
  posts: Array<{
    provider: string;
    postType: 'text';
    body: string;
    scheduledAt: string;
  }>;
}

const DEFAULT_CHANNELS = ['facebook', 'instagram', 'linkedin'];
const CHANNEL_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'X',
  tiktok: 'TikTok',
  email: 'Email',
  blog: 'Blog',
};

export function parseChannels(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function addDays(date: Date, days: number, hour = 9): string {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(hour, 0, 0, 0);
  return next.toISOString();
}

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

export function buildDeterministicCampaignPlan(campaign: CampaignPlanningInput): CampaignPlan {
  const channels = parseChannels(campaign.channels);
  const selected = channels.length > 0 ? channels : DEFAULT_CHANNELS;
  const goal = campaign.goal?.trim() || `Grow awareness for ${campaign.name}`;
  const audience = campaign.audience?.trim() || 'the target audience';
  const now = new Date();

  const themes = [
    'Problem and pain point',
    'Proof and credibility',
    'Product benefit',
    'Customer story',
    'Clear call to action',
  ];

  const posts = selected.flatMap((provider, channelIndex) => {
    const label = channelLabel(provider);
    return themes.slice(0, 3).map((theme, themeIndex) => ({
      provider,
      postType: 'text' as const,
      scheduledAt: addDays(now, channelIndex + themeIndex * selected.length + 1, 9 + (channelIndex % 4)),
      body: `${label} draft for "${campaign.name}"\n\nTheme: ${theme}\nAudience: ${audience}\nGoal: ${goal}\n\nCTA: Reply or click through to learn more.`,
    }));
  });

  return {
    summary: `Launch a ${selected.length}-channel campaign for "${campaign.name}" focused on ${goal}.`,
    channels: selected,
    audience,
    themes,
    cadence: 'Three draft posts per selected channel over the next two weeks.',
    approvalMode: 'approve_first',
    posts,
  };
}
