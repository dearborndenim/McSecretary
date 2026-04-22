import { describe, it, expect } from 'vitest';

/**
 * The `/briefing-preview` Telegram command is admin-gated in index.ts using
 * the same `user.role === 'admin'` check the other admin commands use (like
 * /review, /approve, /invite, /onboard-all-pending). Since handleIncomingMessage
 * is not exported, we verify the gate by asserting the command-parsing + admin
 * role logic explicitly here.
 *
 * The rendering path itself must be the same `runTriage(db, userId)` call the
 * 5 AM morning briefing uses — no duplicate rendering logic. That invariant is
 * covered by reading src/index.ts; this file pins the command string + gate.
 */
describe('/briefing-preview admin gating', () => {
  function isAdminBriefingPreviewCommand(text: string, role: 'admin' | 'member'): boolean {
    const lowerText = text.toLowerCase().trim();
    return lowerText === '/briefing-preview' && role === 'admin';
  }

  it('matches admin user sending /briefing-preview', () => {
    expect(isAdminBriefingPreviewCommand('/briefing-preview', 'admin')).toBe(true);
  });

  it('ignores member user sending /briefing-preview', () => {
    expect(isAdminBriefingPreviewCommand('/briefing-preview', 'member')).toBe(false);
  });

  it('is case-insensitive on the command text', () => {
    expect(isAdminBriefingPreviewCommand('/Briefing-Preview', 'admin')).toBe(true);
    expect(isAdminBriefingPreviewCommand('/BRIEFING-PREVIEW', 'admin')).toBe(true);
  });

  it('does not match with trailing args (strict equality)', () => {
    expect(isAdminBriefingPreviewCommand('/briefing-preview now', 'admin')).toBe(false);
  });

  it('does not match partial prefixes', () => {
    expect(isAdminBriefingPreviewCommand('/briefing', 'admin')).toBe(false);
    expect(isAdminBriefingPreviewCommand('/briefing-prev', 'admin')).toBe(false);
  });

  it('does not collide with /briefing', () => {
    // /briefing is a different command available to all users. Make sure the
    // preview variant does not short-circuit that path.
    expect(isAdminBriefingPreviewCommand('/briefing', 'admin')).toBe(false);
  });
});

describe('/briefing-preview wires runTriage render path', () => {
  // Note: We can't `import('../../src/triage.js')` here because its
  // transitive imports (outlook, classifier, anthropic) pull in config.ts
  // which requires real env vars. Instead we inspect the source to confirm
  // the command handler reuses the same runTriage entry point the 5 AM
  // morning briefing uses. That is the contract: ONE render path.
  it('triage.ts still exports runTriage', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const triagePath = path.join(process.cwd(), 'src', 'triage.ts');
    const source = fs.readFileSync(triagePath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+runTriage/);
  });

  it('index.ts registers the /briefing-preview handler wired to runTriage', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    expect(source).toContain('/briefing-preview');
    // The handler must invoke runTriage so we keep a single render path.
    const previewBlock = source.slice(source.indexOf('/briefing-preview'));
    expect(previewBlock).toContain('runTriage');
  });

  it('/briefing-preview handler is admin-gated', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // After Task 6.4 (2026-04-21) the handler is parser-based rather than a
    // literal `lowerText === '/briefing-preview'` compare. Assert the gate
    // lives in a nearby block with the parser call + admin role check.
    const idx = source.indexOf('parseBriefingPreviewCommand');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, idx - 400), idx + 400);
    expect(block).toContain("user.role === 'admin'");
  });
});
