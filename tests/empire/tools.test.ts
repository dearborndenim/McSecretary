import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the GitHub helpers so we never hit real APIs.
const mockListOrgRepos = vi.fn();
const mockReadRepoFile = vi.fn();
let tokenPresent = true;

vi.mock('../../src/empire/github.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/empire/github.js')>(
    '../../src/empire/github.js',
  );
  return {
    GITHUB_TOKEN_MISSING_MESSAGE: actual.GITHUB_TOKEN_MISSING_MESSAGE,
    GitHubNotFoundError: actual.GitHubNotFoundError,
    isGitHubNotFound: actual.isGitHubNotFound,
    hasGitHubToken: () => tokenPresent,
    listOrgRepos: (...args: unknown[]) => mockListOrgRepos(...args),
    readRepoFile: (...args: unknown[]) => mockReadRepoFile(...args),
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    github: { token: 'test-token', org: 'dearborndenim' },
  },
}));

import { executeEmpireTool, isEmpireTool, EMPIRE_TOOL_DEFINITIONS } from '../../src/empire/tools.js';
import { GITHUB_TOKEN_MISSING_MESSAGE, GitHubNotFoundError } from '../../src/empire/github.js';

beforeEach(() => {
  vi.clearAllMocks();
  tokenPresent = true;
});

// ---------- registry ----------

const REMOVED_TOOLS = [
  'append_project_feedback',
  'get_nightly_plan',
  'update_nightly_plan',
  'append_to_nightly_plan',
];

describe('EMPIRE_TOOL_DEFINITIONS (read-only, Robert 2026-09-10)', () => {
  it('registers exactly the two read tools', () => {
    expect(EMPIRE_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'list_projects',
      'read_project_status',
    ]);
  });

  it('each tool has name, description, and input_schema', () => {
    for (const tool of EMPIRE_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
    }
  });

  it('both descriptions say they are read-only', () => {
    for (const tool of EMPIRE_TOOL_DEFINITIONS) {
      expect(tool.description?.toLowerCase(), tool.name).toContain('read-only');
    }
  });

  it('no tool description offers a write, a build, or a queued task', () => {
    // Strip the read-only disclaimer first: it legitimately names the verbs it forbids.
    const blob = JSON.stringify(EMPIRE_TOOL_DEFINITIONS)
      .toLowerCase()
      .replace('read-only: it cannot edit, append to, or create any file.', '');
    for (const banned of ['append', 'nightly', 'commit', 'queue', 'foreman', 'write', 'update']) {
      expect(blob, banned).not.toContain(banned);
    }
  });

  it('read_project_status states the write prohibition in its own description', () => {
    const d = EMPIRE_TOOL_DEFINITIONS.find((t) => t.name === 'read_project_status')?.description ?? '';
    expect(d).toContain('cannot edit, append to, or create any file');
  });
});

describe('removed write tools', () => {
  it('isEmpireTool rejects every removed tool name', () => {
    for (const name of REMOVED_TOOLS) {
      expect(isEmpireTool(name), name).toBe(false);
    }
  });

  it('isEmpireTool accepts the two read tools', () => {
    expect(isEmpireTool('read_project_status')).toBe(true);
    expect(isEmpireTool('list_projects')).toBe(true);
  });

  it('isEmpireTool returns false for unrelated names', () => {
    expect(isEmpireTool('send_email')).toBe(false);
    expect(isEmpireTool('')).toBe(false);
  });

  it('the executor is a no-op for every removed tool and touches no GitHub helper', async () => {
    for (const name of REMOVED_TOOLS) {
      expect(await executeEmpireTool(name, { project_name: 'McSecretary', feedback_text: 'x' }), name).toBe('');
    }
    expect(mockReadRepoFile).not.toHaveBeenCalled();
    expect(mockListOrgRepos).not.toHaveBeenCalled();
  });

  it('the executor is a no-op for an unknown tool name', async () => {
    expect(await executeEmpireTool('nonexistent_tool', {})).toBe('');
  });
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

  it('returns the missing-token sentence and makes no request when GITHUB_TOKEN is unset', async () => {
    tokenPresent = false;

    const result = await executeEmpireTool('read_project_status', { project_name: 'McSecretary' });

    expect(result).toBe(GITHUB_TOKEN_MISSING_MESSAGE);
    expect(result).toContain('GITHUB_TOKEN missing');
    expect(result.split('\n')).toHaveLength(1);
    expect(mockReadRepoFile).not.toHaveBeenCalled();
  });

  it('names the org and lists projects when the repo does not exist', async () => {
    mockReadRepoFile.mockRejectedValue(
      new GitHubNotFoundError('File not found: PROJECT_STATUS.md in dearborndenim/ghost-project'),
    );
    mockListOrgRepos.mockResolvedValue([
      { name: 'McSecretary', description: null, pushed_at: '2026-09-09T12:00:00Z' },
      { name: 'content-engine', description: null, pushed_at: '2026-09-08T12:00:00Z' },
    ]);

    const result = await executeEmpireTool('read_project_status', { project_name: 'ghost-project' });

    expect(result).toBe(
      'No repo named ghost-project in dearborndenim; projects: McSecretary, content-engine',
    );
    expect(result).not.toContain('404');
  });

  it('omits the project list when the org listing is also unavailable', async () => {
    mockReadRepoFile.mockRejectedValue(new GitHubNotFoundError('File not found'));
    mockListOrgRepos.mockRejectedValue(new Error('GitHub API error listing repos: 403 Forbidden'));

    const result = await executeEmpireTool('read_project_status', { project_name: 'ghost-project' });

    expect(result).toBe('No repo named ghost-project in dearborndenim');
  });

  it('distinguishes an existing repo with no status file from a missing repo', async () => {
    mockReadRepoFile.mockRejectedValue(new GitHubNotFoundError('File not found'));
    mockListOrgRepos.mockResolvedValue([
      { name: 'content-engine', description: null, pushed_at: '2026-09-08T12:00:00Z' },
    ]);

    const result = await executeEmpireTool('read_project_status', { project_name: 'content-engine' });

    expect(result).toContain('content-engine');
    expect(result).toContain('no PROJECT_STATUS.md');
    expect(result).not.toContain('No repo named');
  });

  it('propagates a non-404 GitHub failure instead of guessing', async () => {
    mockReadRepoFile.mockRejectedValue(new Error('GitHub API error reading file: 500 Server Error'));

    await expect(
      executeEmpireTool('read_project_status', { project_name: 'McSecretary' }),
    ).rejects.toThrow('500');
    expect(mockListOrgRepos).not.toHaveBeenCalled();
  });

  it('reports a missing project_name without calling GitHub', async () => {
    const result = await executeEmpireTool('read_project_status', {});
    expect(result).toContain('missing project_name');
    expect(mockReadRepoFile).not.toHaveBeenCalled();
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
    expect(result).toMatch(/^- /m);
  });

  it('returns the missing-token sentence and makes no request when GITHUB_TOKEN is unset', async () => {
    tokenPresent = false;

    const result = await executeEmpireTool('list_projects', {});

    expect(result).toBe(GITHUB_TOKEN_MISSING_MESSAGE);
    expect(result.split('\n')).toHaveLength(1);
    expect(mockListOrgRepos).not.toHaveBeenCalled();
  });

  it('returns message when no repos found', async () => {
    mockListOrgRepos.mockResolvedValue([]);
    expect(await executeEmpireTool('list_projects', {})).toBe('No repositories found in the org.');
  });

  it('handles repo with no description gracefully', async () => {
    mockListOrgRepos.mockResolvedValue([
      { name: 'bare-repo', description: null, pushed_at: '2026-04-01T00:00:00Z' },
    ]);

    const result = await executeEmpireTool('list_projects', {});
    expect(result).toContain('bare-repo');
    expect(result).not.toContain('null');
  });
});
