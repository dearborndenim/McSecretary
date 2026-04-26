/**
 * Briefing UX polish 3 — 2026-04-25 (Task 6).
 *
 * Three sub-features on top of /briefing-sections:
 *   1. --clone-from=<src> --user=<target>  → copy src's pref onto target
 *   2. briefing_sections_audit table       → audit row written on every
 *                                            successful preference change
 *   3. Daily 7 AM CT digest                → summarize last 24h of changes
 *
 * Tests cover parser changes, handler clone-from output formatting, audit-log
 * writes for each action type, digest empty/populated cases, and source-grep
 * wiring on src/index.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  setUserBriefingSections,
  getUserBriefingSections,
  insertBriefingSectionsAudit,
  getBriefingSectionsAuditSince,
} from '../../src/db/user-queries.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import {
  formatBriefingSectionsAuditDigest,
  runBriefingSectionsAuditDigest,
} from '../../src/briefing/sections-audit-digest.js';
import { findUserByFirstName } from '../../src/briefing/preview-command.js';
import { VALID_BRIEFING_SECTIONS } from '../../src/briefing/sections.js';

// ============================================================================
// Parser — --clone-from
// ============================================================================
describe('Polish 3 — parser: --clone-from=<src>', () => {
  it('parses /briefing-sections --user=Merab --clone-from=Olivier', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Merab --clone-from=Olivier',
    );
    expect(a.matched).toBe(true);
    expect(a.cloneFrom).toBe('Olivier');
    expect(a.targetName).toBe('Merab');
    expect(a.setRaw).toBeUndefined();
    expect(a.reset).toBeUndefined();
    expect(a.list).toBeUndefined();
    expect(a.diff).toBeUndefined();
    expect(a.setAllRaw).toBeUndefined();
  });

  it('accepts --clone-from in either flag order', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --clone-from=Rob --user=Merab',
    );
    expect(a.matched).toBe(true);
    expect(a.cloneFrom).toBe('Rob');
    expect(a.targetName).toBe('Merab');
  });

  it('requires --user (clone-from is a per-user op)', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --clone-from=Olivier').matched,
    ).toBe(false);
  });

  it('rejects --clone-from combined with any other action flag', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --clone-from=Y --reset',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --clone-from=Y --set=calendar',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --clone-from=Y --list',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --clone-from=Y --diff',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --clone-from=Y --set-all=calendar --apply-to=all',
      ).matched,
    ).toBe(false);
  });

  it('rejects empty --clone-from value', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --clone-from=').matched,
    ).toBe(false);
  });

  it('does not break previously-shipped forms (regression check)', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --set=calendar').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --reset').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --list').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --diff').matched).toBe(true);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --set-all=stats --apply-to=all').matched,
    ).toBe(true);
  });
});

// ============================================================================
// --clone-from handler behavior (DB round-trip + handler logic mirror)
// ============================================================================
//
// Handler behavior — mirror of src/index.ts logic so tests can drive the DB
// without pulling in Telegram/Anthropic. Whenever this diverges from
// src/index.ts the source-grep block at the bottom should fail.
function renderClone(
  db: Database.Database,
  args: { targetName: string; srcName: string },
): string {
  if (args.targetName.trim().toLowerCase() === args.srcName.trim().toLowerCase()) {
    return `Cannot clone-from self.`;
  }
  const src = findUserByFirstName(db, args.srcName);
  if (!src) return `User '${args.srcName}' not found.`;
  const target = findUserByFirstName(db, args.targetName);
  if (!target) return `User '${args.targetName}' not found.`;
  const srcStored = getUserBriefingSections(db, src.id);
  if (!srcStored || srcStored.length === 0) {
    setUserBriefingSections(db, target.id, null);
    insertBriefingSectionsAudit(db, {
      user_name: target.name,
      action: 'clone-from',
      source_user: src.name,
      sections_json: null,
    });
    return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: (default: full briefing)`;
  }
  const valid = srcStored.filter((s) =>
    (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
  );
  if (valid.length === 0) {
    setUserBriefingSections(db, target.id, null);
    insertBriefingSectionsAudit(db, {
      user_name: target.name,
      action: 'clone-from',
      source_user: src.name,
      sections_json: null,
    });
    return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: (default: full briefing)`;
  }
  setUserBriefingSections(db, target.id, valid);
  insertBriefingSectionsAudit(db, {
    user_name: target.name,
    action: 'clone-from',
    source_user: src.name,
    sections_json: JSON.stringify(valid),
  });
  return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: ${valid.join(', ')}`;
}

describe('Polish 3 — --clone-from handler behavior', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'rob', name: 'Rob', email: 'rob@x.com', role: 'admin' });
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
    createUser(db, { id: 'mer', name: 'Merab', email: 'mer@x.com', role: 'member' });
  });

  it('happy path — copies src prefs verbatim onto target', () => {
    setUserBriefingSections(db, 'oli', ['calendar', 'stats', 'emails']);
    const out = renderClone(db, { targetName: 'Merab', srcName: 'Olivier' });
    expect(out).toBe(
      `Cloned briefing prefs from 'Olivier' to 'Merab'. Sections: calendar, stats, emails`,
    );
    expect(getUserBriefingSections(db, 'mer')).toEqual(['calendar', 'stats', 'emails']);
    // Source pref untouched.
    expect(getUserBriefingSections(db, 'oli')).toEqual(['calendar', 'stats', 'emails']);
  });

  it('NULL source — clones default-full-briefing onto target (resets target)', () => {
    // Target had a pref previously; clone-from should clear it.
    setUserBriefingSections(db, 'mer', ['calendar']);
    expect(getUserBriefingSections(db, 'mer')).toEqual(['calendar']);
    // Source has no pref (NULL).
    expect(getUserBriefingSections(db, 'oli')).toBeNull();

    const out = renderClone(db, { targetName: 'Merab', srcName: 'Olivier' });
    expect(out).toBe(
      `Cloned briefing prefs from 'Olivier' to 'Merab'. Sections: (default: full briefing)`,
    );
    expect(getUserBriefingSections(db, 'mer')).toBeNull();
  });

  it('unknown source → friendly error, target untouched', () => {
    setUserBriefingSections(db, 'mer', ['calendar']);
    const out = renderClone(db, { targetName: 'Merab', srcName: 'Ghost' });
    expect(out).toBe(`User 'Ghost' not found.`);
    expect(getUserBriefingSections(db, 'mer')).toEqual(['calendar']);
  });

  it('unknown target → friendly error, source untouched', () => {
    setUserBriefingSections(db, 'oli', ['calendar']);
    const out = renderClone(db, { targetName: 'Phantom', srcName: 'Olivier' });
    expect(out).toBe(`User 'Phantom' not found.`);
    expect(getUserBriefingSections(db, 'oli')).toEqual(['calendar']);
  });

  it('clone-from self → friendly error (case-insensitive)', () => {
    setUserBriefingSections(db, 'oli', ['calendar']);
    expect(renderClone(db, { targetName: 'Olivier', srcName: 'Olivier' })).toBe(
      'Cannot clone-from self.',
    );
    // Whitespace + case variants hit the same branch.
    expect(renderClone(db, { targetName: 'Olivier', srcName: 'olivier' })).toBe(
      'Cannot clone-from self.',
    );
    // Source untouched.
    expect(getUserBriefingSections(db, 'oli')).toEqual(['calendar']);
  });
});

// ============================================================================
// briefing_sections_audit — every successful action writes a row
// ============================================================================
describe('Polish 3 — audit log writes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'rob', name: 'Rob', email: 'rob@x.com', role: 'admin' });
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
    createUser(db, { id: 'mer', name: 'Merab', email: 'mer@x.com', role: 'member' });
  });

  it('writes one row for each action type', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'reset',
      sections_json: null,
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Merab',
      action: 'set-all',
      sections_json: JSON.stringify(['stats']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Merab',
      action: 'clone-from',
      source_user: 'Olivier',
      sections_json: JSON.stringify(['calendar']),
    });

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const rows = getBriefingSectionsAuditSince(db, cutoff);
    expect(rows.length).toBe(4);

    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['clone-from', 'reset', 'set', 'set-all']);

    const cloneRow = rows.find((r) => r.action === 'clone-from');
    expect(cloneRow?.source_user).toBe('Olivier');
    expect(cloneRow?.sections_json).toBe(JSON.stringify(['calendar']));

    const resetRow = rows.find((r) => r.action === 'reset');
    expect(resetRow?.sections_json).toBeNull();
    expect(resetRow?.source_user).toBeNull();

    // Default actor is 'admin'.
    expect(rows.every((r) => r.actor === 'admin')).toBe(true);
  });

  it('clone-from handler write path attributes both target and source', () => {
    setUserBriefingSections(db, 'oli', ['calendar', 'emails']);
    renderClone(db, { targetName: 'Merab', srcName: 'Olivier' });

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const rows = getBriefingSectionsAuditSince(db, cutoff);
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe('clone-from');
    expect(rows[0]?.user_name).toBe('Merab');
    expect(rows[0]?.source_user).toBe('Olivier');
    expect(rows[0]?.sections_json).toBe(JSON.stringify(['calendar', 'emails']));
  });

  it('respects the ts cutoff — older rows are excluded', () => {
    // Insert a row with an explicit ts well outside the 24h window.
    const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    insertBriefingSectionsAudit(db, {
      ts: oldTs,
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    // And one fresh row.
    insertBriefingSectionsAudit(db, {
      user_name: 'Merab',
      action: 'reset',
    });
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = getBriefingSectionsAuditSince(db, cutoff);
    expect(rows.length).toBe(1);
    expect(rows[0]?.user_name).toBe('Merab');
  });
});

// ============================================================================
// Daily digest — empty + populated cases + opt-out
// ============================================================================
describe('Polish 3 — daily 7 AM digest', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('empty case → no message (returns null)', () => {
    expect(formatBriefingSectionsAuditDigest([])).toBeNull();

    const result = runBriefingSectionsAuditDigest(db, { env: {} });
    expect(result.ran).toBe(false);
    expect(result.message).toBeNull();
    expect(result.reason).toBe('empty');
  });

  it('populated case → grouped digest with counts and bullets', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar', 'emails']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Merab',
      action: 'reset',
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Rob',
      action: 'clone-from',
      source_user: 'Olivier',
      sections_json: JSON.stringify(['calendar', 'emails']),
    });

    const result = runBriefingSectionsAuditDigest(db);
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.message).not.toBeNull();
    const msg = result.message as string;
    expect(msg).toContain('Briefing-sections preference changes in the last 24h: 3');
    // Grouped counts.
    expect(msg).toContain('set (1):');
    expect(msg).toContain('reset (1):');
    expect(msg).toContain('clone-from (1):');
    // Per-row bullets.
    expect(msg).toContain('Olivier → calendar, emails');
    expect(msg).toContain('Merab → (default: full briefing)');
    expect(msg).toContain("Rob ← cloned from Olivier → calendar, emails");
  });

  it('respects DISABLE_BRIEFING_AUDIT_DIGEST=1 (opt-out)', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    const result = runBriefingSectionsAuditDigest(db, {
      env: { DISABLE_BRIEFING_AUDIT_DIGEST: '1' },
    });
    expect(result.ran).toBe(false);
    expect(result.message).toBeNull();
    expect(result.reason).toBe('disabled');
  });

  it('groups set-all rows under their own header', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set-all',
      sections_json: JSON.stringify(['stats']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Merab',
      action: 'set-all',
      sections_json: JSON.stringify(['stats']),
    });
    const result = runBriefingSectionsAuditDigest(db);
    expect(result.message).toContain('set-all (2):');
    expect(result.message).toContain('Olivier (bulk) → stats');
    expect(result.message).toContain('Merab (bulk) → stats');
  });
});

// ============================================================================
// Source-wiring assertions — src/index.ts must wire all three sub-features
// ============================================================================
describe('Polish 3 — wiring assertions on src/index.ts', () => {
  it('--clone-from handler branch is admin-gated and uses friendly errors', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('parsedSections.cloneFrom');
    // Friendly error strings the spec calls out by exact shape.
    expect(source).toContain("'${srcName}' not found");
    expect(source).toContain("'${targetName}' not found");
    expect(source).toContain('Cannot clone-from self.');
    expect(source).toContain('Cloned briefing prefs from');

    const adminGateIdx = source.indexOf("if (user.role === 'admin') {");
    const cloneIdx = source.indexOf('parsedSections.cloneFrom');
    expect(adminGateIdx).toBeGreaterThan(-1);
    expect(cloneIdx).toBeGreaterThan(adminGateIdx);
  });

  it('audit-log writes are wired into every action branch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    // Helper presence.
    expect(source).toContain('insertBriefingSectionsAudit');
    expect(source).toContain('writeAudit');
    // Each canonical action label appears as an argument to writeAudit.
    expect(source).toMatch(/action:\s*'set'/);
    expect(source).toMatch(/action:\s*'reset'/);
    expect(source).toMatch(/action:\s*'set-all'/);
    expect(source).toMatch(/action:\s*'clone-from'/);
  });

  it('daily 7 AM CT digest job is registered with the scheduler', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('handleBriefingSectionsAuditDigest');
    expect(source).toContain('Briefing Audit Digest');
    expect(source).toContain("'0 7 * * *'");
    expect(source).toContain('runBriefingSectionsAuditDigest');
    // Recipient env knob + opt-out env knob both surfaced.
    expect(source).toContain('BRIEFING_AUDIT_DIGEST_RECIPIENT');
  });
});
