/**
 * Empire coordination tool definitions and executor.
 * Lets McSecretary read/write PROJECT_STATUS.md files and
 * manage projects across the dearborndenim GitHub org.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { listOrgRepos, readRepoFile, getFileSha, updateRepoFile } from './github.js';

export const EMPIRE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'read_project_status',
    description:
      'Read a project\'s PROJECT_STATUS.md from the dearborndenim GitHub org. Use when Rob asks for status on a project.',
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
    name: 'append_project_feedback',
    description:
      'Append feedback to a project\'s PROJECT_STATUS.md under the "Robert\'s Feedback" section. Use when Rob gives feedback on a project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: {
          type: 'string',
          description: 'Repository name in the dearborndenim org',
        },
        feedback_text: {
          type: 'string',
          description: 'The feedback text to append',
        },
      },
      required: ['project_name', 'feedback_text'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List all repositories in the dearborndenim GitHub org with their last push date and description. Use when Rob asks for a project overview or "status all".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_nightly_plan',
    description:
      'Read the NIGHTLY_PLAN.md from the claude_code repo. Shows tonight\'s prioritized task queue. Use when Rob asks about the plan or what\'s next.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

function getTodayDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

export async function executeEmpireTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'read_project_status': {
      const projectName = input.project_name as string;
      const content = await readRepoFile(projectName, 'PROJECT_STATUS.md');
      return content;
    }

    case 'append_project_feedback': {
      const projectName = input.project_name as string;
      const feedbackText = input.feedback_text as string;
      const today = getTodayDate();

      // Read current file
      let currentContent: string;
      let sha: string;
      try {
        currentContent = await readRepoFile(projectName, 'PROJECT_STATUS.md');
        sha = await getFileSha(projectName, 'PROJECT_STATUS.md');
      } catch {
        // File doesn't exist — create it with feedback section
        const newContent = `# ${projectName} — Project Status\n\n## Robert's Feedback\n\n### ${today}\n- ${feedbackText}\n`;
        await updateRepoFile(
          projectName,
          'PROJECT_STATUS.md',
          newContent,
          `Add PROJECT_STATUS.md with feedback from ${today}`,
        );
        return `Created PROJECT_STATUS.md in ${projectName} with feedback.`;
      }

      // Append feedback under "Robert's Feedback" section
      const feedbackSection = "## Robert's Feedback";
      const feedbackEntry = `\n### ${today}\n- ${feedbackText}`;

      let updatedContent: string;
      const sectionIndex = currentContent.indexOf(feedbackSection);

      if (sectionIndex !== -1) {
        // Insert right after the section heading
        const insertPos = sectionIndex + feedbackSection.length;
        updatedContent =
          currentContent.slice(0, insertPos) +
          feedbackEntry +
          currentContent.slice(insertPos);
      } else {
        // Section doesn't exist — append it at the end
        updatedContent = currentContent.trimEnd() + '\n\n' + feedbackSection + feedbackEntry + '\n';
      }

      await updateRepoFile(
        projectName,
        'PROJECT_STATUS.md',
        updatedContent,
        `Add Rob's feedback for ${today}`,
        sha,
      );

      return `Feedback appended to ${projectName}/PROJECT_STATUS.md for ${today}.`;
    }

    case 'list_projects': {
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

    case 'get_nightly_plan': {
      // Try claude_code repo first (parent monorepo)
      try {
        const content = await readRepoFile('claude_code', 'NIGHTLY_PLAN.md');
        return content;
      } catch {
        // Fall back to McSecretary repo
        try {
          const content = await readRepoFile('McSecretary', 'NIGHTLY_PLAN.md');
          return content;
        } catch {
          return 'NIGHTLY_PLAN.md not found in claude_code or McSecretary repos.';
        }
      }
    }

    default:
      return '';
  }
}

/** Check if a tool name belongs to the empire tools */
export function isEmpireTool(name: string): boolean {
  return EMPIRE_TOOL_DEFINITIONS.some((t) => t.name === name);
}
