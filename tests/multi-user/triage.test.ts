import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';

describe('per-user briefing', () => {
  it('should accept userContext parameter without errors', () => {
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 5, archived: 2, flaggedForReview: 1 },
      undefined,
      undefined,
      undefined,
      { name: 'Merab', business_context: 'Merab manages wholesale accounts' },
    );
    expect(prompt).toContain('Total emails processed: 5');
    expect(prompt).toContain('Auto-archived: 2');
  });
});
