import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the GitHub helpers so we never hit real APIs
const mockListOrgRepos = vi.fn();
const mockReadRepoFile = vi.fn();
const mockGetFileSha = vi.fn();
const mockUpdateRepoFile = vi.fn();

vi.mock('../../src/empire/github.js', () => ({
  listOrgRepos: (...args: unknown[]) => mockListOrgRepos(...args),
  readRepoFile: (...args: unknown[]) => mockReadRepoFile(...args),
  getFileSha: (...args: unknown[]) => mockGetFileSha(...args),
  updateRepoFile: (...args: unknown[]) => mockUpdateRepoFile(...args),
}));

// Mock config (required by transitive import)
vi.mock('../../src/config.js', () => ({
  config: {
    github: { token: 'test-token', org: 'test-org' },
  },
}));

import { executeEmpireTool, isEmpireTool, EMPIRE_TOOL_DEFINITIONS } from '../../src/empire/tools.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------- read_project_status ----------

describe('read_project_status', () => {
  it('returns the content of PROJECT_STATUS.md', async () => {
    const statusContent = '# McSecretary\n\n## Status\n65% complete';
    mockReadRepoFile.mockResolvedValue(statusContent);

    const result = await executeEmpireTool('read_project_status', {
      project_name: 'McSecretary',
    });

    expect(result).toBe(statusContent);
    expect(mockReadRepoFile).toHaveBeenCalledWith('McSecretary', 'PROJECT_STATUS.md');
  });

  it('propagates error when file is missing', async () => {
    mockReadRepoFile.mockRejectedValue(new Error('File not found: PROJECT_STATUS.md in test-org/ghost-project'));

    await expect(
      executeEmpireTool('read_project_status', { project_name: 'ghost-project' }),
    ).rejects.toThrow('File not found');
  });
});

// ---------- append_project_feedback ----------

describe('append_project_feedback', () => {
  it('appends feedback under existing Robert\'s Feedback section', async () => {
    const existing = "# Project\n\n## Robert's Feedback\n\n### 2026-04-09\n- Looks good\n";
    mockReadRepoFile.mockResolvedValue(existing);
    mockGetFileSha.mockResolvedValue('sha-existing');
    mockUpdateRepoFile.mockResolvedValue(undefined);

    const result = await executeEmpireTool('append_project_feedback', {
      project_name: 'McSecretary',
      feedback_text: 'Need better error handling',
    });

    expect(result).toContain('Feedback appended');
    expect(result).toContain('McSecretary');

    // Verify updateRepoFile was called with correct args
    expect(mockUpdateRepoFile).toHaveBeenCalledWith(
      'McSecretary',
      'PROJECT_STATUS.md',
      expect.stringContaining('Need better error handling'),
      expect.any(String),
      'sha-existing',
    );

    // The updated content should still contain old feedback
    const updatedContent = mockUpdateRepoFile.mock.calls[0][2] as string;
    expect(updatedContent).toContain('Looks good');
    expect(updatedContent).toContain('Need better error handling');
  });

  it('appends feedback section at end when section does not exist', async () => {
    const existing = '# Project\n\n## Overview\nSome project info.';
    mockReadRepoFile.mockResolvedValue(existing);
    mockGetFileSha.mockResolvedValue('sha-456');
    mockUpdateRepoFile.mockResolvedValue(undefined);

    await executeEmpireTool('append_project_feedback', {
      project_name: 'content-engine',
      feedback_text: 'Images need work',
    });

    const updatedContent = mockUpdateRepoFile.mock.calls[0][2] as string;
    expect(updatedContent).toContain("## Robert's Feedback");
    expect(updatedContent).toContain('Images need work');
    expect(updatedContent).toContain('Some project info.');
  });

  it('creates PROJECT_STATUS.md when file does not exist', async () => {
    mockReadRepoFile.mockRejectedValue(new Error('File not found'));
    mockUpdateRepoFile.mockResolvedValue(undefined);

    const result = await executeEmpireTool('append_project_feedback', {
      project_name: 'new-project',
      feedback_text: 'Kickoff feedback',
    });

    expect(result).toContain('Created PROJECT_STATUS.md');
    expect(mockUpdateRepoFile).toHaveBeenCalledWith(
      'new-project',
      'PROJECT_STATUS.md',
      expect.stringContaining('Kickoff feedback'),
      expect.stringContaining('Add PROJECT_STATUS.md'),
    );
  });
});

// ---------- list_projects ----------

describe('list_projects', () => {
  it('returns formatted repo list with descriptions and dates', async () => {
    mockListOrgRepos.mockResolvedValue([
      { name: 'McSecretary', description: 'AI secretary', pushed_at: '2026-04-09T12:00:00Z' },
      { name: 'content-engine', description: null, pushed_at: '2026-04-08T08:00:00Z' },
    ]);

    const result = await executeEmpireTool('list_projects', {});

    expect(result).toContain('McSecretary');
    expect(result).toContain('AI secretary');
    expect(result).toContain('content-engine');
    expect(result).toContain('last push:');
    // Should be formatted as bullet list
    expect(result).toMatch(/^- /m);
  });

  it('returns message when no repos found', async () => {
    mockListOrgRepos.mockResolvedValue([]);

    const result = await executeEmpireTool('list_projects', {});
    expect(result).toBe('No repositories found in the org.');
  });

  it('handles repo with no description gracefully', async () => {
    mockListOrgRepos.mockResolvedValue([
      { name: 'bare-repo', description: null, pushed_at: '2026-04-01T00:00:00Z' },
    ]);

    const result = await executeEmpireTool('list_projects', {});
    expect(result).toContain('bare-repo');
    // Should not contain " -- null" or similar
    expect(result).not.toContain('null');
  });
});

// ---------- get_nightly_plan ----------

describe('get_nightly_plan', () => {
  it('reads from claude_code repo first', async () => {
    mockReadRepoFile.mockResolvedValue('# Nightly Plan\n\n1. Build tests');

    const result = await executeEmpireTool('get_nightly_plan', {});
    expect(result).toContain('Nightly Plan');
    expect(mockReadRepoFile).toHaveBeenCalledWith('claude_code', 'NIGHTLY_PLAN.md');
  });

  it('falls back to McSecretary repo', async () => {
    mockReadRepoFile
      .mockRejectedValueOnce(new Error('Not found'))
      .mockResolvedValueOnce('# Fallback Plan');

    const result = await executeEmpireTool('get_nightly_plan', {});
    expect(result).toBe('# Fallback Plan');
    expect(mockReadRepoFile).toHaveBeenCalledTimes(2);
    expect(mockReadRepoFile).toHaveBeenCalledWith('McSecretary', 'NIGHTLY_PLAN.md');
  });

  it('returns not-found message when both repos fail', async () => {
    mockReadRepoFile
      .mockRejectedValueOnce(new Error('Not found'))
      .mockRejectedValueOnce(new Error('Not found'));

    const result = await executeEmpireTool('get_nightly_plan', {});
    expect(result).toContain('NIGHTLY_PLAN.md not found');
  });
});

// ---------- unknown tool ----------

describe('unknown tool', () => {
  it('returns empty string for unknown tool name', async () => {
    const result = await executeEmpireTool('nonexistent_tool', {});
    expect(result).toBe('');
  });
});

// ---------- isEmpireTool ----------

describe('isEmpireTool', () => {
  it('returns true for known empire tools', () => {
    expect(isEmpireTool('read_project_status')).toBe(true);
    expect(isEmpireTool('append_project_feedback')).toBe(true);
    expect(isEmpireTool('list_projects')).toBe(true);
    expect(isEmpireTool('get_nightly_plan')).toBe(true);
  });

  it('returns false for unknown tools', () => {
    expect(isEmpireTool('send_email')).toBe(false);
    expect(isEmpireTool('')).toBe(false);
  });
});

// ---------- tool definitions ----------

describe('EMPIRE_TOOL_DEFINITIONS', () => {
  it('defines 4 tools', () => {
    expect(EMPIRE_TOOL_DEFINITIONS).toHaveLength(4);
  });

  it('each tool has name, description, and input_schema', () => {
    for (const tool of EMPIRE_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
    }
  });
});
