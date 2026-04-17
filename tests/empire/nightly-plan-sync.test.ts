import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  insertDevRequest,
  approveDevRequest,
  getApprovedDevRequests,
  markDevRequestSynced,
  getApprovedUnsyncedDevRequests,
} from '../../src/db/request-queries.js';

// Mock GitHub helpers
const mockReadRepoFile = vi.fn();
const mockGetFileSha = vi.fn();
const mockUpdateRepoFile = vi.fn();
const mockListOrgRepos = vi.fn();

vi.mock('../../src/empire/github.js', () => ({
  listOrgRepos: (...a: unknown[]) => mockListOrgRepos(...a),
  readRepoFile: (...a: unknown[]) => mockReadRepoFile(...a),
  getFileSha: (...a: unknown[]) => mockGetFileSha(...a),
  updateRepoFile: (...a: unknown[]) => mockUpdateRepoFile(...a),
}));

vi.mock('../../src/config.js', () => ({
  config: { github: { token: 't', org: 'dearborndenim' } },
}));

import { executeEmpireTool, setEmpireDb, EMPIRE_TOOL_DEFINITIONS } from '../../src/empire/tools.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dev_requests sync tracking', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'u1', name: 'Olivier', email: 'o@dd.com', role: 'member' });
  });

  it('has synced_at column on dev_requests table', () => {
    const info = db.prepare('PRAGMA table_info(dev_requests)').all() as { name: string }[];
    const names = info.map((c) => c.name);
    expect(names).toContain('synced_at');
  });

  it('getApprovedUnsyncedDevRequests excludes already-synced rows', () => {
    const id = insertDevRequest(db, { user_id: 'u1', description: 'first task' });
    approveDevRequest(db, id, 'admin1');
    expect(getApprovedUnsyncedDevRequests(db)).toHaveLength(1);
    markDevRequestSynced(db, id);
    expect(getApprovedUnsyncedDevRequests(db)).toHaveLength(0);
    // Still in approved list
    expect(getApprovedDevRequests(db)).toHaveLength(1);
  });
});

describe('update_nightly_plan tool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'u1', name: 'Olivier', email: 'o@dd.com', role: 'member' });
    setEmpireDb(db);
  });

  it('is in EMPIRE_TOOL_DEFINITIONS', () => {
    const names = EMPIRE_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('update_nightly_plan');
    expect(names).toContain('append_to_nightly_plan');
  });

  it('writes approved unsynced requests to NIGHTLY_PLAN.md and marks them synced', async () => {
    const id = insertDevRequest(db, {
      user_id: 'u1',
      project: 'kanban-purchaser',
      description: 'Add reorder alerts',
    });
    approveDevRequest(db, id, 'admin1', 'Add reorder threshold alerts to kanban-purchaser');

    const existingPlan = [
      '# Nightly Plan',
      '',
      '## Next Session Priority Queue',
      '- old task',
      '',
      '## Other Section',
      'content here',
    ].join('\n');

    mockReadRepoFile.mockResolvedValue(existingPlan);
    mockGetFileSha.mockResolvedValue('sha-abc');
    mockUpdateRepoFile.mockResolvedValue(undefined);

    const result = await executeEmpireTool('update_nightly_plan', {});
    expect(result).toContain('update_nightly_plan');

    // Should have called updateRepoFile with content containing the team request
    expect(mockUpdateRepoFile).toHaveBeenCalled();
    const call = mockUpdateRepoFile.mock.calls[0];
    const content = call[2] as string;
    expect(content).toContain('Team Request #');
    expect(content).toContain('Add reorder threshold alerts');
    expect(content).toContain('## Next Session Priority Queue');
    expect(content).toContain('## Other Section'); // didn't destroy other sections

    // Request should be marked synced
    expect(getApprovedUnsyncedDevRequests(db)).toHaveLength(0);
  });

  it('returns no-op message when there are no approved unsynced requests', async () => {
    const result = await executeEmpireTool('update_nightly_plan', {});
    expect(result.toLowerCase()).toContain('no approved');
    expect(mockUpdateRepoFile).not.toHaveBeenCalled();
  });
});

describe('append_to_nightly_plan tool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    setEmpireDb(db);
  });

  it('appends an arbitrary task under Next Session Priority Queue', async () => {
    const existingPlan = [
      '# Nightly Plan',
      '',
      '## Next Session Priority Queue',
      '- existing task',
      '',
    ].join('\n');
    mockReadRepoFile.mockResolvedValue(existingPlan);
    mockGetFileSha.mockResolvedValue('sha-xyz');
    mockUpdateRepoFile.mockResolvedValue(undefined);

    const result = await executeEmpireTool('append_to_nightly_plan', {
      task_description: 'Investigate cron drift',
    });

    expect(result.toLowerCase()).toContain('appended');
    const call = mockUpdateRepoFile.mock.calls[0];
    const content = call[2] as string;
    expect(content).toContain('Investigate cron drift');
    expect(content).toContain('existing task');
  });

  it('creates Next Session Priority Queue section if missing', async () => {
    const existingPlan = '# Nightly Plan\n\n## Some other section\nstuff\n';
    mockReadRepoFile.mockResolvedValue(existingPlan);
    mockGetFileSha.mockResolvedValue('sha-xyz');
    mockUpdateRepoFile.mockResolvedValue(undefined);

    await executeEmpireTool('append_to_nightly_plan', {
      task_description: 'New arbitrary task',
    });

    const call = mockUpdateRepoFile.mock.calls[0];
    const content = call[2] as string;
    expect(content).toContain('## Next Session Priority Queue');
    expect(content).toContain('New arbitrary task');
  });
});
