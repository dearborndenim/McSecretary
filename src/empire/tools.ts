/**
 * Empire coordination tools — READ ONLY (Robert, 2026-09-10).
 *
 * McSecretary may READ PROJECT_STATUS.md files and list repos in the
 * dearborndenim GitHub org. It may not write to GitHub, file feedback,
 * queue build work, or run code. Anything that would modify a repository
 * goes to the Foreman session (Claude Code) instead.
 *
 * Both tools degrade to a single explanatory sentence when GITHUB_TOKEN is
 * unset, rather than throwing into the chat loop.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import {
  listOrgRepos,
  readRepoFile,
  hasGitHubToken,
  isGitHubNotFound,
  GITHUB_TOKEN_MISSING_MESSAGE,
} from './github.js';

export const EMPIRE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'read_project_status',
    description:
      "Read a project's PROJECT_STATUS.md from the dearborndenim GitHub org. Read-only: it cannot edit, append to, or create any file. Use when Rob asks for status on a project.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: {
          type: 'string',
          description:
            'Repository name in the dearborndenim org (e.g., "McSecretary", "DDA-CS-Manager", "content-engine")',
        },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List all repositories in the dearborndenim GitHub org with their last push date and description. Read-only. Use when Rob asks for a project overview or "status all".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

/** Repo names for the "did you mean" list, or null when the org listing fails. */
async function tryListRepoNames(): Promise<string[] | null> {
  try {
    const repos = await listOrgRepos();
    return repos.map((r) => r.name);
  } catch {
    return null;
  }
}

export async function executeEmpireTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'read_project_status': {
      if (!hasGitHubToken()) return GITHUB_TOKEN_MISSING_MESSAGE;

      const projectName = (input.project_name as string | undefined)?.trim() ?? '';
      if (!projectName) return 'read_project_status: missing project_name.';

      try {
        return await readRepoFile(projectName, 'PROJECT_STATUS.md');
      } catch (err) {
        if (!isGitHubNotFound(err)) throw err;

        const org = config.github.org;
        const names = await tryListRepoNames();
        if (names && names.some((n) => n.toLowerCase() === projectName.toLowerCase())) {
          return `${projectName} exists in ${org} but has no PROJECT_STATUS.md yet.`;
        }
        const suffix = names && names.length > 0 ? `; projects: ${names.join(', ')}` : '';
        return `No repo named ${projectName} in ${org}${suffix}`;
      }
    }

    case 'list_projects': {
      if (!hasGitHubToken()) return GITHUB_TOKEN_MISSING_MESSAGE;

      const repos = await listOrgRepos();

      if (repos.length === 0) {
        return 'No repositories found in the org.';
      }

      return repos
        .map((r) => {
          const pushed = new Date(r.pushed_at).toLocaleDateString('en-US', {
            timeZone: 'America/Chicago',
            month: 'short',
            day: 'numeric',
          });
          const desc = r.description ? ` — ${r.description}` : '';
          return `- ${r.name}${desc} (last push: ${pushed})`;
        })
        .join('\n');
    }

    default:
      return '';
  }
}

/** Check if a tool name belongs to the empire tools */
export function isEmpireTool(name: string): boolean {
  return EMPIRE_TOOL_DEFINITIONS.some((t) => t.name === name);
}
