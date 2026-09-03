/**
 * Per-agent bearer keys so the audit trail names the agent (spec §3.3).
 * Env: AGENT_KEYS="marketing-manager:<key>,finance:<key>"
 */
export function parseAgentKeys(raw: string | undefined, opts: { minLength?: number } = {}): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx <= 0) throw new Error(`AGENT_KEYS entry missing ':' — ${p}`);
    const agent = p.slice(0, idx).trim();
    const key = p.slice(idx + 1).trim();
    if (!key) throw new Error(`AGENT_KEYS key for ${agent} is empty`);
    if (opts.minLength && key.length < opts.minLength) {
      throw new Error(`AGENT_KEYS key for ${agent} is shorter than ${opts.minLength} chars`);
    }
    if (map.has(key)) throw new Error(`AGENT_KEYS duplicate key for ${agent}`);
    map.set(key, agent);
  }
  return map;
}

export function agentForBearer(keys: Map<string, string>, authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return keys.get(authHeader.slice(7)) ?? null;
}
