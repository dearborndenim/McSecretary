/**
 * GitHub API helpers for empire coordination.
 * Uses native fetch — no additional dependencies.
 */

import { config } from '../config.js';

const GITHUB_API = 'https://api.github.com';

function getHeaders(): Record<string, string> {
  const token = config.github.token;
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured. Set it in environment variables.');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'McSecretary',
  };
}

/**
 * List all repos in the configured GitHub org.
 */
export async function listOrgRepos(): Promise<
  { name: string; description: string | null; pushed_at: string }[]
> {
  const org = config.github.org;
  const res = await fetch(`${GITHUB_API}/orgs/${org}/repos?sort=pushed&per_page=100`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error listing repos: ${res.status} ${text}`);
  }

  const repos = (await res.json()) as {
    name: string;
    description: string | null;
    pushed_at: string;
  }[];

  return repos.map((r) => ({
    name: r.name,
    description: r.description,
    pushed_at: r.pushed_at,
  }));
}

/**
 * Read a file from a GitHub repo (default branch).
 * Returns the decoded UTF-8 content.
 */
export async function readRepoFile(
  repoName: string,
  filePath: string,
): Promise<string> {
  const org = config.github.org;
  const url = `${GITHUB_API}/repos/${org}/${repoName}/contents/${encodeURIComponent(filePath)}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`File not found: ${filePath} in ${org}/${repoName}`);
    }
    const text = await res.text();
    throw new Error(`GitHub API error reading file: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { content: string; encoding: string; sha: string };

  if (data.encoding !== 'base64') {
    throw new Error(`Unexpected encoding: ${data.encoding}`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/**
 * Get the SHA of a file in a GitHub repo (needed for updates).
 */
export async function getFileSha(
  repoName: string,
  filePath: string,
): Promise<string> {
  const org = config.github.org;
  const url = `${GITHUB_API}/repos/${org}/${repoName}/contents/${encodeURIComponent(filePath)}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error getting file SHA: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/**
 * Update (or create) a file in a GitHub repo via the Contents API.
 * Commits directly to the default branch.
 */
export async function updateRepoFile(
  repoName: string,
  filePath: string,
  content: string,
  commitMessage: string,
  sha?: string,
): Promise<void> {
  const org = config.github.org;
  const url = `${GITHUB_API}/repos/${org}/${repoName}/contents/${encodeURIComponent(filePath)}`;

  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };

  if (sha) {
    body.sha = sha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...getHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error updating file: ${res.status} ${text}`);
  }
}
