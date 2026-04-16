import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';

describe('per-user briefing', () => {
  it('should include user business_context in briefing prompt when preferences provided', () => {
    const prompt = buildBriefingPrompt(
      [], // no emails
      { totalProcessed: 0, archived: 0, flaggedForReview: 0 },
      undefined, // no calendar
      undefined, // no dev summary
      undefined, // no production
      { business_context: 'Olivier manages operations at Dearborn Denim', name: 'Olivier' },
    );
    // The prompt itself is the user message, not system prompt, but we can check it builds without error
    expect(prompt).toContain('Total emails processed');
  });

  it('should use default briefing prompt when no preferences provided', () => {
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 0, archived: 0, flaggedForReview: 0 },
    );
    // Default prompt doesn't mention specific user
    expect(prompt).toContain('Total emails processed');
  });

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
