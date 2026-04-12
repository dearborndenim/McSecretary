import { describe, it, expect } from 'vitest';
import { getJournalHealthReport, ensureJournalDirs } from '../../src/journal/files.js';

describe('getJournalHealthReport', () => {
  it('returns a formatted health report', () => {
    ensureJournalDirs();
    const report = getJournalHealthReport();

    // Should include reflection file status for last 7 days
    expect(report).toContain('Reflection files (last 7 days):');

    // Should include either PRESENT or MISSING for each day
    const lines = report.split('\n');
    const statusLines = lines.filter((l) => l.includes('PRESENT') || l.includes('MISSING'));
    expect(statusLines.length).toBe(7);

    // Should include master file info
    expect(report).toMatch(/master-learnings\.md:/);
    expect(report).toMatch(/master-patterns\.md:/);

    // Should include next synthesis date
    expect(report).toContain('Next scheduled synthesis:');
    expect(report).toContain('Sunday 7 PM CT');
  });
});
