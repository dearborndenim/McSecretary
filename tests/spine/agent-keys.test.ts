import { describe, it, expect } from 'vitest';
import { parseAgentKeys, agentForBearer } from '../../src/spine/agent-keys.js';

describe('agent keys', () => {
  it('parses agent:key pairs and ignores blanks', () => {
    const m = parseAgentKeys('marketing-manager:abc, finance:def,,');
    expect(m.get('abc')).toBe('marketing-manager');
    expect(m.get('def')).toBe('finance');
    expect(m.size).toBe(2);
  });

  it('resolves an Authorization header to an agent name', () => {
    const m = parseAgentKeys('finance:def');
    expect(agentForBearer(m, 'Bearer def')).toBe('finance');
    expect(agentForBearer(m, 'Bearer nope')).toBeNull();
    expect(agentForBearer(m, undefined)).toBeNull();
  });

  it('refuses keys shorter than 16 chars at parse time', () => {
    expect(() => parseAgentKeys('finance:short', { minLength: 16 })).toThrow(/finance/);
  });

  it('rejects an empty key regardless of minLength', () => {
    expect(() => parseAgentKeys('finance:')).toThrow(/finance.*empty/);
    expect(() => parseAgentKeys('finance: ')).toThrow(/finance.*empty/);
  });

  it('rejects the same key used by two agents', () => {
    expect(() => parseAgentKeys('finance:abc,marketing-manager:abc')).toThrow(/duplicate key for marketing-manager/);
  });
});
