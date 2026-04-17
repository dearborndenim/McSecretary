/**
 * Empire coordination tool definitions and executor.
 * Lets McSecretary read/write PROJECT_STATUS.md files and
 * manage projects across the dearborndenim GitHub org.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { listOrgRepos, readRepoFile, getFileSha, updateRepoFile } from './github.js';
import { formatApprovedRequestsForPlan } from './request-sync.js';
import {
  getApprovedUnsyncedDevRequests,
  markDevRequestSynced,
} from '../db/request-queries.js';

let empireDb: Database.Database | null = null;

/** Injects a DB handle so empire tools can mark requests as synced. */
export function setEmpireDb(db: Database.Database): void {
  empireDb = db;
}

const NIGHTLY_PLAN_REPO = 'claude_code';
const NIGHTLY_PLAN_FILE = 'NIGHTLY_PLAN.md';
const PRIORITY_QUEUE_SECTION = '## Next Session Priority Queue';

/**
 * Insert `newContent` into the plan file, keeping the Priority Queue section intact
 * but adding `newContent` after the existing bullet list (and before the next H2/H1).
 * If the section doesn't exist it's appended at the end of the file.
 */
function mergeIntoPriorityQueue(currentPlan: string, newContent: string): string {
  const trimmed = newContent.trimEnd();
  const sectionIdx = currentPlan.indexOf(PRIORITY_QUEUE_SECTION);
  if (sectionIdx === -1) {
    const sep = currentPlan.endsWith('\n') ? '' : '\n';
    return `${currentPlan}${sep}\n${PRIORITY_QUEUE_SECTION}\n\n${trimmed}\n`;
  }

  // Find the end of this section (next top-level heading or EOF).
  const afterHeader = sectionIdx + PRIORITY_QUEUE_SECTION.length;
  const rest = currentPlan.slice(afterHeader);
  // Look for next "\n## " or "\n# " heading
  const nextHeadingMatch = rest.match(/\n(#+\s[^\n]+)/);
  let insertAt: number;
  if (nextHeadingMatch) {
    insertAt = afterHeader + (nextHeadingMatch.index ?? 0);
  } else {
    insertAt = currentPlan.length;
  }

  const before = currentPlan.slice(0, insertAt).trimEnd();
  const after = currentPlan.slice(insertAt);
  return `${before}\n\n${trimmed}\n${after.startsWith('\n') ? after : '\n' + after}`;
}

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
  {
    name: 'update_nightly_plan',
    description:
      'Sync all approved-but-not-yet-synced team dev requests to NIGHTLY_PLAN.md in the claude_code repo under "Next Session Priority Queue". Use after /approve to make sure the Foreman sees the request in its nightly build.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'append_to_nightly_plan',
    description:
      'Append an arbitrary task (free-form text) to the "Next Session Priority Queue" section of NIGHTLY_PLAN.md in the claude_code repo. Use when Rob asks to add something directly to tomorrow\'s build.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_description: {
          type: 'string',
          description: 'Task text to append, e.g., "Investigate cron drift in McSecretary scheduler".',
        },
      },
      required: ['task_description'],
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

    case 'update_nightly_plan': {
      if (!empireDb) {
        return 'update_nightly_plan: DB not configured. Call setEmpireDb() at startup.';
      }
      const unsynced = getApprovedUnsyncedDevRequests(empireDb);
      if (unsynced.length === 0) {
        return 'update_nightly_plan: no approved unsynced requests to sync.';
      }

      const section = formatApprovedRequestsForPlan(empireDb, true);
      // Read current plan (if missing, create minimal file)
      let currentPlan: string;
      let sha: string | undefined;
      try {
        currentPlan = await readRepoFile(NIGHTLY_PLAN_REPO, NIGHTLY_PLAN_FILE);
        sha = await getFileSha(NIGHTLY_PLAN_REPO, NIGHTLY_PLAN_FILE);
      } catch {
        currentPlan = `# Nightly Plan\n\n${PRIORITY_QUEUE_SECTION}\n`;
        sha = undefined;
      }

      const updated = mergeIntoPriorityQueue(currentPlan, section);
      await updateRepoFile(
        NIGHTLY_PLAN_REPO,
        NIGHTLY_PLAN_FILE,
        updated,
        `update_nightly_plan: sync ${unsynced.length} approved team request(s)`,
        sha,
      );

      // Mark all pushed requests as synced in DB
      for (const r of unsynced) {
        markDevRequestSynced(empireDb, r.id);
      }

      return `update_nightly_plan: synced ${unsynced.length} approved request(s) to NIGHTLY_PLAN.md.`;
    }

    case 'append_to_nightly_plan': {
      const taskDescription = (input.task_description as string | undefined)?.trim();
      if (!taskDescription) {
        return 'append_to_nightly_plan: missing task_description.';
      }

      let currentPlan: string;
      let sha: string | undefined;
      try {
        currentPlan = await readRepoFile(NIGHTLY_PLAN_REPO, NIGHTLY_PLAN_FILE);
        sha = await getFileSha(NIGHTLY_PLAN_REPO, NIGHTLY_PLAN_FILE);
      } catch {
        currentPlan = `# Nightly Plan\n\n${PRIORITY_QUEUE_SECTION}\n`;
        sha = undefined;
      }

      const line = `- ${taskDescription}`;
      const updated = mergeIntoPriorityQueue(currentPlan, line);
      await updateRepoFile(
        NIGHTLY_PLAN_REPO,
        NIGHTLY_PLAN_FILE,
        updated,
        `append_to_nightly_plan: ${taskDescription.slice(0, 60)}`,
        sha,
      );
      return `append_to_nightly_plan: task appended to NIGHTLY_PLAN.md.`;
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
