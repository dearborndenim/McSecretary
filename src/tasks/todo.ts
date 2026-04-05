/**
 * Microsoft To Do integration via Graph API.
 * Manages task lists and tasks for Rob's daily todo lists and project tracking.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface TodoTaskList {
  id: string;
  displayName: string;
}

export interface TodoTask {
  id: string;
  title: string;
  status: 'notStarted' | 'inProgress' | 'completed';
  importance: 'low' | 'normal' | 'high';
  dueDateTime?: { dateTime: string; timeZone: string };
  body?: { content: string; contentType: string };
  createdDateTime: string;
}

async function getToken(): Promise<string> {
  const { getGraphToken } = await import('../auth/graph.js');
  return getGraphToken();
}

async function getUserEmail(): Promise<string> {
  const { config } = await import('../config.js');
  return config.outlook.email1;
}

// === Task Lists ===

export async function getTaskLists(): Promise<TodoTaskList[]> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(`${GRAPH_BASE}/users/${email}/todo/lists`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get task lists: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { value: TodoTaskList[] };
  return data.value;
}

export async function createTaskList(name: string): Promise<TodoTaskList> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(`${GRAPH_BASE}/users/${email}/todo/lists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName: name }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create task list: ${response.status} ${text}`);
  }

  return (await response.json()) as TodoTaskList;
}

export async function findOrCreateTaskList(name: string): Promise<TodoTaskList> {
  const lists = await getTaskLists();
  const existing = lists.find((l) => l.displayName.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return createTaskList(name);
}

// === Tasks ===

export async function getTasks(listId: string): Promise<TodoTask[]> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(
    `${GRAPH_BASE}/users/${email}/todo/lists/${listId}/tasks?$orderby=createdDateTime desc&$top=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get tasks: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { value: TodoTask[] };
  return data.value;
}

export async function getIncompleteTasks(listId: string): Promise<TodoTask[]> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(
    `${GRAPH_BASE}/users/${email}/todo/lists/${listId}/tasks?$filter=status ne 'completed'&$orderby=importance desc,createdDateTime desc&$top=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get tasks: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { value: TodoTask[] };
  return data.value;
}

export async function createTask(
  listId: string,
  title: string,
  options?: {
    importance?: 'low' | 'normal' | 'high';
    dueDate?: string; // YYYY-MM-DD
    body?: string;
  },
): Promise<TodoTask> {
  const token = await getToken();
  const email = await getUserEmail();

  const taskBody: any = { title };

  if (options?.importance) {
    taskBody.importance = options.importance;
  }

  if (options?.dueDate) {
    taskBody.dueDateTime = {
      dateTime: `${options.dueDate}T17:00:00`,
      timeZone: 'America/Chicago',
    };
  }

  if (options?.body) {
    taskBody.body = {
      content: options.body,
      contentType: 'html',
    };
  }

  const response = await fetch(`${GRAPH_BASE}/users/${email}/todo/lists/${listId}/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(taskBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create task: ${response.status} ${text}`);
  }

  return (await response.json()) as TodoTask;
}

export async function completeTask(listId: string, taskId: string): Promise<void> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(`${GRAPH_BASE}/users/${email}/todo/lists/${listId}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'completed' }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to complete task: ${response.status} ${text}`);
  }
}

export async function deleteTask(listId: string, taskId: string): Promise<void> {
  const token = await getToken();
  const email = await getUserEmail();

  const response = await fetch(`${GRAPH_BASE}/users/${email}/todo/lists/${listId}/tasks/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to delete task: ${response.status} ${text}`);
  }
}

// === Convenience: formatted task list for AI context ===

export async function getFormattedTaskLists(): Promise<string> {
  const lists = await getTaskLists();
  if (lists.length === 0) return 'No task lists found in Microsoft To Do.';

  const results: string[] = [];

  for (const list of lists) {
    const tasks = await getIncompleteTasks(list.id);
    if (tasks.length === 0) {
      results.push(`${list.displayName}: (no incomplete tasks)`);
    } else {
      const taskList = tasks
        .map((t) => {
          const due = t.dueDateTime ? ` (due: ${t.dueDateTime.dateTime.split('T')[0]})` : '';
          const imp = t.importance === 'high' ? ' [HIGH]' : '';
          return `  - ${t.title}${imp}${due}`;
        })
        .join('\n');
      results.push(`${list.displayName}:\n${taskList}`);
    }
  }

  return results.join('\n\n');
}
