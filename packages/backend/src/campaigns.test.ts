import { describe, expect, it } from 'vitest';
import { buildDeterministicCampaignPlan } from './planner.js';

describe('buildDeterministicCampaignPlan', () => {
  it('creates three draft posts per selected channel', () => {
    const plan = buildDeterministicCampaignPlan({
      name: 'Indie SaaS Launch',
      goal: 'get 500 waitlist signups',
      audience: 'indie hackers',
      channels: JSON.stringify(['facebook', 'instagram']),
    });

    expect(plan.channels).toEqual(['facebook', 'instagram']);
    expect(plan.posts).toHaveLength(6);
    expect(plan.posts.every((post) => post.postType === 'text')).toBe(true);
    expect(plan.posts[0]?.body).toContain('Indie SaaS Launch');
    expect(plan.posts[0]?.body).toContain('indie hackers');
  });

  it('falls back to default channels and goal context', () => {
    const plan = buildDeterministicCampaignPlan({
      name: 'Local Cafe',
      goal: null,
      audience: null,
      channels: '[]',
    });

    expect(plan.channels).toEqual(['facebook', 'instagram', 'linkedin']);
    expect(plan.audience).toBe('the target audience');
    expect(plan.summary).toContain('Local Cafe');
    expect(plan.posts).toHaveLength(9);
  });
});
