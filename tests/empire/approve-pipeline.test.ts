import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  insertDevRequest,
  approveDevRequest,
  getApprovedUnsyncedDevRequests,
  getDevRequestById,
} from '../../src/db/request-queries.js';

// Mock GitHub so we never hit a real API, and trace what was written.
const mockReadRepoFile = vi.fn();
const mockGetFileSha = vi.fn();
const mockUpdateRepoFile = vi.fn();
vi.mock('../../src/empire/github.js', () => ({
  listOrgRepos: vi.fn(),
  readRepoFile: (...a: unknown[]) => mockReadRepoFile(...a),
  getFileSha: (...a: unknown[]) => mockGetFileSha(...a),
  updateRepoFile: (...a: unknown[]) => mockUpdateRepoFile(...a),
}));

vi.mock('../../src/config.js', () => ({
  config: { github: { token: 't', org: 'dearborndenim' } },
}));

import { executeEmpireTool, setEmpireDb } from '../../src/empire/tools.js';

describe('approve -> update_nightly_plan pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'u1', name: 'Olivier', email: 'o@dd.com', role: 'member' });
    setEmpireDb(db);
    mockReadRepoFile.mockResolvedValue(
      '# Nightly Plan\n\n## Next Session Priority Queue\n- old task\n\n## Blockers\nnone\n',
    );
    mockGetFileSha.mockResolvedValue('sha-0');
    mockUpdateRepoFile.mockResolvedValue(undefined);
  });

  it('full flow: request -> approve -> sync pushes to GitHub and marks synced', async () => {
    const id = insertDevRequest(db, {
      user_id: 'u1',
      project: 'kanban-purchaser',
      description: 'rough idea',
    });

    // Approve with a refined description.
    approveDevRequest(db, id, 'admin1', 'Add reorder threshold alerts to kanban-purchaser');

    expect(getApprovedUnsyncedDevRequests(db)).toHaveLength(1);

    const syncResult = await executeEmpireTool('update_nightly_plan', {});
    expect(syncResult).toContain('synced 1');

    // Verify GitHub received correct content
    const call = mockUpdateRepoFile.mock.calls[0];
    const [repo, file, content, msg] = call;
    expect(repo).toBe('claude_code');
    expect(file).toBe('NIGHTLY_PLAN.md');
    expect(content).toContain('Team Request #');
    expect(content).toContain('Add reorder threshold alerts to kanban-purchaser');
    expect(content).toContain('Olivier');
    expect(content).toContain('## Blockers'); // other sections preserved
    expect(msg).toContain('update_nightly_plan');

    // Second sync is a no-op (already synced)
    const secondResult = await executeEmpireTool('update_nightly_plan', {});
    expect(secondResult.toLowerCase()).toContain('no approved');
    // Only the first call hit updateRepoFile
    expect(mockUpdateRepoFile).toHaveBeenCalledTimes(1);

    // The DB row has synced_at populated
    const row = getDevRequestById(db, id);
    expect(row?.synced_at).not.toBeNull();
  });

  it('rejects are never synced', async () => {
    const id = insertDevRequest(db, { user_id: 'u1', description: 'rejected' });
    db.prepare("UPDATE dev_requests SET status = 'rejected' WHERE id = ?").run(id);

    const result = await executeEmpireTool('update_nightly_plan', {});
    expect(result.toLowerCase()).toContain('no approved');
    expect(mockUpdateRepoFile).not.toHaveBeenCalled();
  });
});
