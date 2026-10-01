import { describe, it, expect } from 'vitest';
import { parseAgentPolicy, matchesType, sourceHandAllowed, type AgentPolicyEntry } from '../../src/spine/agent-policy.js';

const KNOWN = ['grok-bots', 'grok-inbox', 'grok-task', 'finance'];

describe('parseAgentPolicy', () => {
  it('returns an empty map for undefined or empty input', () => {
    expect(parseAgentPolicy(undefined, ['finance']).size).toBe(0);
    expect(parseAgentPolicy('', ['finance']).size).toBe(0);
  });

  it('throws on malformed policies with a message naming the problem', () => {
    for (const [raw, re] of [
      ['{not json', /not valid JSON/],
      ['[]', /JSON object/],
      ['{"finance": 3}', /entry for finance must be an object/],
      ['{"finance": {"propse": null}}', /finance: unknown field propse/],
      ['{"finance": {"propose": {"hands": [], "action_type": []}}}', /unknown field propose\.action_type/],
      ['{"finance": {"events": {"post_type": []}}}', /unknown field events\.post_type/],
      ['{"finance": {"rate": {"per_hour": 5}}}', /unknown field rate\.per_hour/],
      ['{"finance": {"hands_proxy": "yes"}}', /hands_proxy must be a boolean/],
      ['{"finance": {"events": {"post_types": "grok_daily"}}}', /events\.post_types must be an array/],
      ['{"finance": {"events": {"drain_types": ["grok_*_x"]}}}', /'\*' only as its last character/],
      ['{"finance": {"events": {"source_hand": "grok-"}}}', /source_hand/],
      ['{"finance": {"rate": {"events_per_hour": 0}}}', /events_per_hour must be an integer >= 1/],
    ] as const) {
      expect(() => parseAgentPolicy(raw, KNOWN), raw).toThrow(re);
    }
  });

  it('refuses a bare * so no pattern can match every type', () => {
    expect(() => parseAgentPolicy('{"finance": {"events": {"drain_types": ["*"]}}}', KNOWN))
      .toThrow("AGENT_POLICY finance: events.drain_types entry * needs a prefix before '*'");
    expect(parseAgentPolicy('{"finance": {"events": {"drain_types": ["grok_task_*"]}}}', ['finance']).get('finance')!.events.drain_types)
      .toEqual(['grok_task_*']);
  });

  it('refuses any * in the exact propose lists', () => {
    expect(() => parseAgentPolicy('{"finance": {"propose": {"hands": ["notes"], "action_types": ["grok_*"]}}}', ['finance']))
      .toThrow("AGENT_POLICY finance: propose.action_types entries are exact; '*' is not allowed");
  });

  it('throws on an entry for an agent with no key', () => {
    expect(() => parseAgentPolicy('{"grok-typo": {}}', ['finance']))
      .toThrow('AGENT_POLICY names grok-typo, which has no key in AGENT_KEYS');
  });

  it('throws when a grok- agent has no entry, even with no policy at all', () => {
    for (const raw of [undefined, '{"finance": {}}']) {
      expect(() => parseAgentPolicy(raw, ['finance', 'grok-bots']))
        .toThrow('AGENT_KEYS agent grok-bots must have an AGENT_POLICY entry');
    }
  });

  it('defaults everything an entry does not grant to refused', () => {
    const p = parseAgentPolicy('{"grok-task":{"events":{"post_types":["grok_task_*"]}}}', ['grok-task']);
    expect(p.get('grok-task')).toEqual({
      propose: null,
      events: { post_types: ['grok_task_*'], drain_types: [], source_hand: 'self' },
      hands_proxy: false, outcomes: false, brands: false, runs: false, rate: null,
    });
  });
});

describe('matchesType', () => {
  it('matches exact names and trailing-* prefixes only', () => {
    expect(matchesType(['grok_daily'], 'grok_daily')).toBe(true);
    expect(matchesType(['grok_task_*'], 'grok_task_gina')).toBe(true);
    expect(matchesType(['grok_task_*'], 'grok_tasks')).toBe(false);
    expect(matchesType(['grok_task_*'], 'grok_daily')).toBe(false);
    expect(matchesType(['grok_lead'], 'grok_lead_x')).toBe(false);
  });
});

describe('sourceHandAllowed', () => {
  const entry = (source_hand: string): AgentPolicyEntry => ({
    propose: null, events: { post_types: [], drain_types: [], source_hand },
    hands_proxy: false, outcomes: false, brands: false, runs: false, rate: null,
  });
  const known = new Set(KNOWN);

  it("rule 'grok-*' allows a bot slug but never a keyed agent or a bad slug", () => {
    for (const ok of ['grok-gina', 'grok-wholesale-tshirt-bot']) {
      expect(sourceHandAllowed(entry('grok-*'), 'grok-bots', ok, known), ok).toBe(true);
    }
    for (const bad of ['grok-inbox', 'grok-task', 'grok-bots', 'finance', 'grok-', 'grok-Bad_Slug']) {
      expect(sourceHandAllowed(entry('grok-*'), 'grok-bots', bad, known), bad).toBe(false);
    }
  });

  it("rule 'self' allows only the agent's own name", () => {
    expect(sourceHandAllowed(entry('self'), 'grok-task', 'grok-task', known)).toBe(true);
    expect(sourceHandAllowed(entry('self'), 'grok-task', 'grok-gina', known)).toBe(false);
  });
});
