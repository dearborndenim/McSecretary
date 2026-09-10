import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../src/config.js', () => ({
  config: {
    github: {
      token: 'test-token-123',
      org: 'test-org',
    },
  },
}));

import * as github from '../../src/empire/github.js';
const { listOrgRepos, readRepoFile } = github;

const originalFetch = globalThis.fetch;

function mockFetch(response: { status: number; ok: boolean; body: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () =>
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------- listOrgRepos ----------

describe('listOrgRepos', () => {
  it('returns parsed repo list with name, description, pushed_at', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: [
        { name: 'repo-a', description: 'First repo', pushed_at: '2026-04-09T12:00:00Z', extra_field: true },
        { name: 'repo-b', description: null, pushed_at: '2026-04-08T08:00:00Z', stargazers_count: 5 },
      ],
    });

    const repos = await listOrgRepos();

    expect(repos).toEqual([
      { name: 'repo-a', description: 'First repo', pushed_at: '2026-04-09T12:00:00Z' },
      { name: 'repo-b', description: null, pushed_at: '2026-04-08T08:00:00Z' },
    ]);

    // Verify correct URL and headers
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.github.com/orgs/test-org/repos?sort=pushed&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token-123',
          'User-Agent': 'McSecretary',
        }),
      }),
    );
  });

  it('returns empty array when org has no repos', async () => {
    mockFetch({ ok: true, status: 200, body: [] });
    const repos = await listOrgRepos();
    expect(repos).toEqual([]);
  });

  it('throws on API error', async () => {
    mockFetch({ ok: false, status: 403, body: 'Forbidden' });
    await expect(listOrgRepos()).rejects.toThrow('GitHub API error listing repos: 403');
  });
});

// ---------- readRepoFile ----------

describe('readRepoFile', () => {
  it('decodes base64 content from GitHub API response', async () => {
    const fileContent = '# Project Status\n\nAll good.';
    mockFetch({
      ok: true,
      status: 200,
      body: {
        content: Buffer.from(fileContent, 'utf-8').toString('base64'),
        encoding: 'base64',
        sha: 'abc123',
      },
    });

    const result = await readRepoFile('my-repo', 'PROJECT_STATUS.md');
    expect(result).toBe(fileContent);
  });

  it('builds the correct API URL with encoded file path', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { content: Buffer.from('x').toString('base64'), encoding: 'base64', sha: 'a' },
    });

    await readRepoFile('my-repo', 'docs/PLAN.md');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/test-org/my-repo/contents/'),
      expect.anything(),
    );
  });

  it('throws specific error on 404', async () => {
    mockFetch({ ok: false, status: 404, body: 'Not Found' });
    await expect(readRepoFile('missing-repo', 'README.md')).rejects.toThrow(
      'File not found: README.md in test-org/missing-repo',
    );
  });

  it('throws generic error on other failures', async () => {
    mockFetch({ ok: false, status: 500, body: 'Server Error' });
    await expect(readRepoFile('repo', 'file.md')).rejects.toThrow(
      'GitHub API error reading file: 500',
    );
  });

  it('throws on unexpected encoding', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { content: 'raw text', encoding: 'utf-8', sha: 'abc' },
    });
    await expect(readRepoFile('repo', 'file.md')).rejects.toThrow('Unexpected encoding: utf-8');
  });
});

// ---------- read-only surface (Robert, 2026-09-10) ----------

describe('read-only GitHub module', () => {
  it('exports no write helper', () => {
    for (const banned of ['getFileSha', 'updateRepoFile', 'createRepoFile', 'deleteRepoFile', 'commitFile']) {
      expect(github, banned).not.toHaveProperty(banned);
    }
  });

  it('exports exactly the read helpers plus the token/not-found utilities', () => {
    expect(Object.keys(github).sort()).toEqual([
      'GITHUB_TOKEN_MISSING_MESSAGE',
      'GitHubNotFoundError',
      'hasGitHubToken',
      'isGitHubNotFound',
      'listOrgRepos',
      'readRepoFile',
    ]);
  });

  it('never issues a non-GET request', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { content: Buffer.from('x').toString('base64'), encoding: 'base64', sha: 'a' },
    });
    await readRepoFile('repo', 'file.md');
    mockFetch({ ok: true, status: 200, body: [] });
    await listOrgRepos();

    for (const call of (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls) {
      const init = call[1] as { method?: string } | undefined;
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('isGitHubNotFound recognizes the 404 error and rejects unrelated failures', async () => {
    mockFetch({ ok: false, status: 404, body: 'Not Found' });
    const err = await readRepoFile('missing', 'README.md').catch((e) => e);
    expect(github.isGitHubNotFound(err)).toBe(true);
    expect(github.isGitHubNotFound(new Error('GitHub API error reading file: 500'))).toBe(false);
  });

  it('hasGitHubToken reflects the configured token', () => {
    expect(github.hasGitHubToken()).toBe(true);
  });
});
