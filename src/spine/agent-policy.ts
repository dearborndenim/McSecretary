/**
 * Per-agent policy (Grok bridge spec §7). Env: AGENT_POLICY = JSON object of
 * `{ "<agent>": <entry> }`. An agent with no entry is unrestricted; an entry
 * grants, and whatever it does not grant is refused. Parsed once at boot and
 * fails loud, like AGENT_KEYS.
 */

export interface AgentPolicyEntry {
  /** null = may not file proposals. */
  propose: { hands: string[]; action_types: string[] } | null;
  events: {
    post_types: string[];   // exact, or ending in '*' = prefix match
    drain_types: string[];  // same matching
    /** 'self' (default): source_hand must equal the agent name. '<prefix>*': see sourceHandAllowed. */
    source_hand: string;
  };
  hands_proxy: boolean;
  outcomes: boolean;
  brands: boolean;
  runs: boolean;
  rate: { events_per_hour: number | null; proposals_per_hour: number | null } | null;
}
export type AgentPolicy = Map<string, AgentPolicyEntry>;

/** Agents whose names start with one of these must have an entry, or boot fails. */
export const RESTRICTED_PREFIXES = ['grok-'];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const ENTRY_FIELDS = ['propose', 'events', 'hands_proxy', 'outcomes', 'brands', 'runs', 'rate'];
const PROPOSE_FIELDS = ['hands', 'action_types'];
const EVENTS_FIELDS = ['post_types', 'drain_types', 'source_hand'];
const RATE_FIELDS = ['events_per_hour', 'proposals_per_hour'];
const ITEM_MAX = 128;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function checkFields(agent: string, where: string, obj: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`AGENT_POLICY ${agent}: unknown field ${where}${k}`);
  }
}

function parseList(agent: string, name: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= ITEM_MAX)) {
    throw new Error(`AGENT_POLICY ${agent}: ${name} must be an array of non-empty strings of at most ${ITEM_MAX} chars`);
  }
  for (const s of v as string[]) {
    if (s.slice(0, -1).includes('*')) throw new Error(`AGENT_POLICY ${agent}: ${name} entry ${s.slice(0, 64)} may have '*' only as its last character`);
    if (s === '*') throw new Error(`AGENT_POLICY ${agent}: ${name} entry * needs a prefix before '*'`);
  }
  return [...(v as string[])];
}

function parseFlag(agent: string, name: string, v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new Error(`AGENT_POLICY ${agent}: ${name} must be a boolean`);
  return v;
}

function parseEntry(agent: string, raw: unknown): AgentPolicyEntry {
  if (!isPlainObject(raw)) throw new Error(`AGENT_POLICY entry for ${agent} must be an object`);
  checkFields(agent, '', raw, ENTRY_FIELDS);

  let propose: AgentPolicyEntry['propose'] = null;
  if (raw.propose !== undefined && raw.propose !== null) {
    if (!isPlainObject(raw.propose)) throw new Error(`AGENT_POLICY ${agent}: propose must be an object or null`);
    checkFields(agent, 'propose.', raw.propose, PROPOSE_FIELDS);
    propose = {
      hands: parseList(agent, 'propose.hands', raw.propose.hands),
      action_types: parseList(agent, 'propose.action_types', raw.propose.action_types),
    };
  }

  let events: AgentPolicyEntry['events'] = { post_types: [], drain_types: [], source_hand: 'self' };
  if (raw.events !== undefined) {
    if (!isPlainObject(raw.events)) throw new Error(`AGENT_POLICY ${agent}: events must be an object`);
    checkFields(agent, 'events.', raw.events, EVENTS_FIELDS);
    const sh = raw.events.source_hand;
    if (sh !== undefined && !(sh === 'self'
      || (typeof sh === 'string' && sh.length >= 2 && sh.length <= ITEM_MAX && sh.endsWith('*') && !sh.slice(0, -1).includes('*')))) {
      throw new Error(`AGENT_POLICY ${agent}: events.source_hand must be 'self' or a prefix ending in '*'`);
    }
    events = {
      post_types: parseList(agent, 'events.post_types', raw.events.post_types),
      drain_types: parseList(agent, 'events.drain_types', raw.events.drain_types),
      source_hand: (sh as string | undefined) ?? 'self',
    };
  }

  let rate: AgentPolicyEntry['rate'] = null;
  if (raw.rate !== undefined && raw.rate !== null) {
    if (!isPlainObject(raw.rate)) throw new Error(`AGENT_POLICY ${agent}: rate must be an object`);
    checkFields(agent, 'rate.', raw.rate, RATE_FIELDS);
    const cap = (name: string): number | null => {
      const n = (raw.rate as Record<string, unknown>)[name];
      if (n === undefined) return null;
      if (!Number.isInteger(n) || (n as number) < 1) throw new Error(`AGENT_POLICY ${agent}: rate.${name} must be an integer >= 1`);
      return n as number;
    };
    rate = { events_per_hour: cap('events_per_hour'), proposals_per_hour: cap('proposals_per_hour') };
    if (rate.events_per_hour === null && rate.proposals_per_hour === null) {
      throw new Error(`AGENT_POLICY ${agent}: rate must set events_per_hour or proposals_per_hour`);
    }
  }

  return {
    propose,
    events,
    hands_proxy: parseFlag(agent, 'hands_proxy', raw.hands_proxy),
    outcomes: parseFlag(agent, 'outcomes', raw.outcomes),
    brands: parseFlag(agent, 'brands', raw.brands),
    runs: parseFlag(agent, 'runs', raw.runs),
    rate,
  };
}

export function parseAgentPolicy(raw: string | undefined, knownAgents: Iterable<string>): AgentPolicy {
  const known = new Set(knownAgents);
  const policy: AgentPolicy = new Map();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('AGENT_POLICY is not valid JSON');
    }
    if (!isPlainObject(parsed)) throw new Error('AGENT_POLICY must be a JSON object of agent entries');
    for (const [agent, entry] of Object.entries(parsed)) {
      if (!known.has(agent)) throw new Error(`AGENT_POLICY names ${agent}, which has no key in AGENT_KEYS`);
      policy.set(agent, parseEntry(agent, entry));
    }
  }
  for (const agent of known) {
    if (RESTRICTED_PREFIXES.some((p) => agent.startsWith(p)) && !policy.has(agent)) {
      throw new Error(`AGENT_KEYS agent ${agent} must have an AGENT_POLICY entry`);
    }
  }
  return policy;
}

export function matchesType(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === type || (p.endsWith('*') && type.startsWith(p.slice(0, -1))));
}

export function mayPropose(entry: AgentPolicyEntry, hand: string, actionType: string): boolean {
  return entry.propose !== null && entry.propose.hands.includes(hand) && entry.propose.action_types.includes(actionType);
}

/**
 * 'self' → the agent's own name only. '<prefix>*' → the prefix plus a valid
 * slug, and never the name of a keyed agent (so a bot cannot post as
 * grok-inbox, grok-task, grok-bots or any business agent).
 */
export function sourceHandAllowed(
  entry: AgentPolicyEntry, agent: string, sourceHand: string, knownAgents: ReadonlySet<string>,
): boolean {
  const rule = entry.events.source_hand;
  if (rule === 'self') return sourceHand === agent;
  const prefix = rule.slice(0, -1);
  return sourceHand.startsWith(prefix)
    && SLUG_RE.test(sourceHand.slice(prefix.length))
    && !knownAgents.has(sourceHand);
}
