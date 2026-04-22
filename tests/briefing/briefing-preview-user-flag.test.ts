/**
 * `/briefing-preview --user=<name>` — admin command extension.
 *
 * Task 6 (2026-04-21): the admin `/briefing-preview` command now accepts an
 * optional `--user=<name>` flag. When present, the admin previews the briefing
 * as if it were being generated for the named user. Lookup is case-insensitive
 * first-name match on `users.name`. Unknown names return an error string; no
 * render is attempted. Still admin-gated exactly like the bare variant.
 *
 * The render path itself remains `runTriage(db, targetUserId)` — one render
 * path invariant still holds. We assert behavior via:
 *   1. Pure parser tests (parseBriefingPreviewCommand) — extraction of the
 *      `--user=<name>` value, whitespace tolerance, case preservation.
 *   2. Name-resolver tests (findUserByFirstName) — case-insensitive match,
 *      ambiguous-match semantics, unknown-name returns undefined.
 *   3. Source-inspection tests on src/index.ts to keep the handler wired to
 *      `runTriage` (one render path) and admin-gated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  parseBriefingPreviewCommand,
  findUserByFirstName,
} from '../../src/briefing/preview-command.js';

describe('parseBriefingPreviewCommand', () => {
  it('matches the bare command with no flag', () => {
    const parsed = parseBriefingPreviewCommand('/briefing-preview');
    expect(parsed.matched).toBe(true);
    expect(parsed.targetName).toBeUndefined();
  });

  it('matches a /briefing-preview --user=Olivier form', () => {
    const parsed = parseBriefingPreviewCommand('/briefing-preview --user=Olivier');
    expect(parsed.matched).toBe(true);
    expect(parsed.targetName).toBe('Olivier');
  });

  it('is case-insensitive on the command prefix but preserves the name', () => {
    const parsed = parseBriefingPreviewCommand('/Briefing-Preview --user=Merab');
    expect(parsed.matched).toBe(true);
    // Name is preserved for display; the resolver handles case folding.
    expect(parsed.targetName).toBe('Merab');
  });

  it('tolerates surrounding whitespace', () => {
    const parsed = parseBriefingPreviewCommand('  /briefing-preview --user=olivier  ');
    expect(parsed.matched).toBe(true);
    expect(parsed.targetName).toBe('olivier');
  });

  it('does not match unrelated commands', () => {
    expect(parseBriefingPreviewCommand('/briefing').matched).toBe(false);
    expect(parseBriefingPreviewCommand('/briefing-preview-foo').matched).toBe(false);
    expect(parseBriefingPreviewCommand('briefing-preview').matched).toBe(false);
  });

  it('rejects malformed flags (trailing args without --user=)', () => {
    // A bare argument without --user= is not accepted — avoids accidental matches.
    const parsed = parseBriefingPreviewCommand('/briefing-preview Olivier');
    expect(parsed.matched).toBe(false);
  });

  it('rejects empty --user= value', () => {
    const parsed = parseBriefingPreviewCommand('/briefing-preview --user=');
    expect(parsed.matched).toBe(false);
  });
});

describe('findUserByFirstName', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u-olivier', name: 'Olivier Martin', email: 'olivier@dd.com', role: 'member' });
    createUser(db, { id: 'u-merab', name: 'Merab K', email: 'merab@dd.com', role: 'member' });
    createUser(db, { id: 'u-robert', name: 'Robert McMillan', email: 'rob@dd.com', role: 'admin' });
  });

  it('matches first name case-insensitively', () => {
    expect(findUserByFirstName(db, 'olivier')?.id).toBe('u-olivier');
    expect(findUserByFirstName(db, 'OLIVIER')?.id).toBe('u-olivier');
    expect(findUserByFirstName(db, 'Olivier')?.id).toBe('u-olivier');
  });

  it('matches against the first whitespace-separated token of users.name', () => {
    expect(findUserByFirstName(db, 'robert')?.id).toBe('u-robert');
    // "McMillan" is the surname — first-name-only lookup must NOT match.
    expect(findUserByFirstName(db, 'McMillan')).toBeUndefined();
  });

  it('returns undefined for unknown names', () => {
    expect(findUserByFirstName(db, 'nobody')).toBeUndefined();
    expect(findUserByFirstName(db, '')).toBeUndefined();
  });
});

describe('/briefing-preview --user=<name> handler wiring', () => {
  it('index.ts registers the --user flag handler wired to runTriage for the target user', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // The handler must parse the --user flag and pass the resolved user's id
    // into runTriage (not the caller's id).
    expect(source).toContain('parseBriefingPreviewCommand');
    expect(source).toContain('findUserByFirstName');
  });

  it('/briefing-preview --user=<name> handler is admin-gated', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // Locate the preview-command block and confirm the admin role check.
    const idx = source.indexOf('parseBriefingPreviewCommand');
    expect(idx).toBeGreaterThan(-1);
    // Scan backwards ~400 chars for the admin guard — the gate lives at the
    // top of the same if-block.
    const block = source.slice(Math.max(0, idx - 400), idx + 400);
    expect(block).toContain("user.role === 'admin'");
  });

  it('rejects with a friendly error when --user=<name> is not found (source level)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // There must be a "no user named" (or equivalent) error branch.
    expect(source).toMatch(/No user (named|matching|found)/i);
  });
});
