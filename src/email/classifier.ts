import Anthropic from '@anthropic-ai/sdk';
import type { RawEmail, ClassifiedEmail } from './types.js';

export const CLASSIFICATION_CATEGORIES = [
  'customer_inquiry',
  'order_related',
  'supplier',
  'team_internal',
  'financial',
  'newsletter',
  'promotional',
  'transactional',
  'personal',
  'junk',
] as const;
export const CLASSIFICATION_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;
export const CLASSIFICATION_ACTIONS = [
  'reply_required',
  'review_required',
  'fyi_only',
  'archive',
  'delete',
] as const;
export const CLASSIFICATION_SENDER_IMPORTANCE = [
  'returning_customer',
  'new_customer',
  'vendor',
  'employee',
  'bank',
  'personal',
  'unknown',
] as const;

/** MCS-5: the labels are guaranteed by the schema, not by prose in the prompt. */
export const CLASSIFICATION_OUTPUT_FORMAT: Anthropic.Messages.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'category',
      'urgency',
      'action_needed',
      'confidence',
      'summary',
      'suggested_action',
      'sender_importance',
    ],
    properties: {
      category: { type: 'string', enum: [...CLASSIFICATION_CATEGORIES] },
      urgency: { type: 'string', enum: [...CLASSIFICATION_URGENCIES] },
      action_needed: { type: 'string', enum: [...CLASSIFICATION_ACTIONS] },
      // The live API rejects minimum/maximum; the range lives in the description and is clamped in parse.
      confidence: { type: 'number', description: 'Confidence in the classification, from 0 (guess) to 1 (certain).' },
      summary: { type: 'string', description: 'One sentence summary of the email' },
      suggested_action: { type: 'string', description: 'What Rob should do about this' },
      sender_importance: { type: 'string', enum: [...CLASSIFICATION_SENDER_IMPORTANCE] },
    },
  },
};

export const SYSTEM_PROMPT = `You are an email triage assistant for Robert McMillan, who owns:
- Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company
- McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing

Your job is to classify incoming emails.

Category guidance:
- customer_inquiry: Questions about products, sizing, orders, samples. Always high priority.
- order_related: Shopify notifications, shipping, fulfillment. Medium priority.
- supplier: Fabric suppliers, manufacturers, logistics. High if delivery/pricing related.
- team_internal: Messages from employees or contractors.
- financial: Bank, payments, invoices, tax. Review required.
- newsletter/promotional: Industry news, marketing, vendor promos. FYI or archive.
- transactional: Password resets, SaaS billing, service notifications. Low priority.
- personal: Family, friends. Flag but separate from business.
- junk: Spam, phishing, irrelevant solicitations. Archive.`;

export function buildClassificationPrompt(email: RawEmail): string {
  return `Classify this email:

From: ${email.senderName} <${email.sender}>
To: ${email.account}
Subject: ${email.subject}
Date: ${email.receivedAt}

Body:
${email.body}`;
}

export interface Classification {
  category: string;
  urgency: string;
  action_needed: string;
  confidence: number;
  summary: string;
  suggested_action: string;
  sender_importance: string;
}

const REQUIRED_KEYS: (keyof Classification)[] = [
  'category',
  'urgency',
  'action_needed',
  'confidence',
  'summary',
  'suggested_action',
  'sender_importance',
];

/**
 * Parse a structured-output response. The API already enforces the schema, so
 * this is a plain JSON.parse plus a shape check at the boundary; it throws on
 * anything that does not match so the caller's error handling sees it.
 */
export function parseClassificationResponse(raw: string): Classification {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Classification response is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) throw new Error(`Classification response missing "${key}"`);
  }
  if (typeof obj.confidence !== 'number' || Number.isNaN(obj.confidence)) {
    throw new Error('Classification response "confidence" is not a number');
  }
  return {
    category: String(obj.category),
    urgency: String(obj.urgency),
    action_needed: String(obj.action_needed),
    confidence: Math.min(1, Math.max(0, obj.confidence)),
    summary: String(obj.summary),
    suggested_action: String(obj.suggested_action),
    sender_importance: String(obj.sender_importance),
  };
}

let anthropicClient: Anthropic | null = null;

export async function classifyEmail(email: RawEmail): Promise<ClassifiedEmail> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildClassificationPrompt(email);

  // No regex/fence repair and no silent 'unknown' fallback: the schema guarantees
  // the shape, and API/parse errors propagate to the caller's per-email catch
  // (triage skips the email this round and retries next run).
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    output_config: { format: CLASSIFICATION_OUTPUT_FORMAT },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const classification = parseClassificationResponse(text);

  return {
    ...email,
    category: classification.category,
    urgency: classification.urgency,
    actionNeeded: classification.action_needed,
    confidence: classification.confidence,
    summary: classification.summary,
    suggestedAction: classification.suggested_action,
    senderImportance: classification.sender_importance,
  };
}
