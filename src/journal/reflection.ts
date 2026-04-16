import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { getTodayConversation, type ConversationMessage } from '../db/conversation-queries.js';
import { getTimeLogsForDate } from '../db/time-queries.js';
import {
  writeSecretaryReflection,
  writeSecretaryImprovements,
  writeSecretaryLearnings,
  readMasterLearnings,
  readMasterPatterns,
} from './files.js';

export async function generateEndOfDayReflection(
  db: Database.Database,
  anthropic: Anthropic,
  date: string,
  userId: string = 'robert-mcmillan',
): Promise<'completed' | 'skipped'> {
  console.log(`Generating end-of-day reflection for ${date}...`);

  const conversation = getTodayConversation(db, userId, date, 200);
  const timeLogs = getTimeLogsForDate(db, userId, date);
  const masterLearnings = readMasterLearnings();
  const masterPatterns = readMasterPatterns();

  if (conversation.length === 0) {
    console.log('No activity at all for this day — service may have been down. Skipping reflection.');
    return 'skipped';
  }

  const hasRobMessages = conversation.some((m) => m.role === 'rob');
  const conversationText = conversation
    .map((m) => `[${m.timestamp}] ${m.role}: ${m.message}`)
    .join('\n\n');

  // If only secretary messages exist (scheduled tasks ran but Rob didn't respond),
  // generate a minimal reflection from the secretary's own activity
  const reflectionContext = hasRobMessages
    ? 'Full conversation with Rob available.'
    : 'Rob did not respond today. Only secretary scheduled activity is available (briefings, check-ins, email scans). Generate a minimal reflection based on what the secretary did.';

  const timeLogText = timeLogs.length === 0
    ? 'No time entries logged.'
    : timeLogs.map((l) => `${l.hour}:00 — ${l.activity}`).join('\n');

  // Generate reflection
  const reflectionResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You are McSecretary reflecting on your day of work assisting Rob McMillan. Write an honest, specific self-assessment. No emoji. Be direct about what went well and what didn't.`,
    messages: [{
      role: 'user',
      content: `Review today's conversation log and write a reflection.

NOTE: ${reflectionContext}

TODAY'S CONVERSATION LOG:
${conversationText}

TIME LOG:
${timeLogText}

CURRENT KNOWLEDGE BASE:
${masterLearnings}

CURRENT PATTERNS:
${masterPatterns}

Write a reflection with these sections:

## What I Did Today
(Summary of conversations, questions answered, actions taken)

## What I Did Well
(Specific examples of helpful, accurate, proactive behavior)

## What I Did Poorly
(Specific examples of wrong answers, missed context, unhelpful responses, times Rob corrected me)

## Key Corrections From Rob
(Any time Rob corrected my understanding — these are critical to learn from)

## Key Interactions
(Notable conversations or decisions worth remembering)`,
    }],
  });

  const reflection = reflectionResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  writeSecretaryReflection(date, `# Secretary Reflection — ${date}\n\n${reflection}`);
  console.log(`Written reflection for ${date}`);

  // Generate improvement plan
  const improvementResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are McSecretary planning how to be better tomorrow. Write specific, actionable improvements. No emoji.`,
    messages: [{
      role: 'user',
      content: `Based on today's reflection, write tomorrow's improvement plan.

TODAY'S REFLECTION:
${reflection}

Write specific behavioral changes:

## What I Will Do Differently Tomorrow
(Concrete actions, not vague goals. E.g., "When Rob asks about new customers, search for Apollo campaign responses first" not "Be better at understanding Rob")

## Corrections to Apply
(Things Rob corrected that I must remember)

## Things to Watch For
(Situations where I struggled today that might come up again)`,
    }],
  });

  const improvements = improvementResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  writeSecretaryImprovements(date, `# Improvement Plan — ${date}\n\n${improvements}`);
  console.log(`Written improvement plan for ${date}`);

  // Generate learnings
  const learningsResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are McSecretary documenting new things you learned today about Rob and his businesses. Only include NEW information not already in the knowledge base. No emoji.`,
    messages: [{
      role: 'user',
      content: `Based on today's conversations, what new things did I learn?

TODAY'S CONVERSATION LOG:
${conversationText}

CURRENT KNOWLEDGE BASE (don't repeat what's already here):
${masterLearnings}

Write only NEW learnings:

## New Facts About Rob
(Preferences, habits, schedule changes)

## New Facts About the Businesses
(Contacts, processes, tools, terminology, customers)

## New Facts About Relationships
(Who works with whom, communication preferences)

If nothing new was learned today, say "No new learnings today."`,
    }],
  });

  const learnings = learningsResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  writeSecretaryLearnings(date, `# Learnings — ${date}\n\n${learnings}`);
  console.log(`Written learnings for ${date}`);
  return 'completed';
}
