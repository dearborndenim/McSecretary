import Anthropic from '@anthropic-ai/sdk';
import type { RawEmail, ClassifiedEmail } from './types.js';

const SYSTEM_PROMPT = `You are an email triage assistant for Robert McMillan, who owns:
- Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company
- McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing

Your job is to classify incoming emails. Respond with ONLY a JSON object (no markdown, no explanation):

{
  "category": "customer_inquiry | order_related | supplier | team_internal | financial | newsletter | promotional | transactional | personal | junk",
  "urgency": "critical | high | medium | low",
  "action_needed": "reply_required | review_required | fyi_only | archive | delete",
  "confidence": 0.0-1.0,
  "summary": "One sentence summary of the email",
  "suggested_action": "What Rob should do about this",
  "sender_importance": "returning_customer | new_customer | vendor | employee | bank | personal | unknown"
}

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

export function parseClassificationResponse(raw: string): Classification {
  const fallback: Classification = {
    category: 'unknown',
    urgency: 'low',
    action_needed: 'review_required',
    confidence: 0,
    summary: 'Failed to classify',
    suggested_action: 'Review manually',
    sender_importance: 'unknown',
  };

  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      category: parsed.category ?? fallback.category,
      urgency: parsed.urgency ?? fallback.urgency,
      action_needed: parsed.action_needed ?? fallback.action_needed,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      summary: parsed.summary ?? fallback.summary,
      suggested_action: parsed.suggested_action ?? fallback.suggested_action,
      sender_importance: parsed.sender_importance ?? fallback.sender_importance,
    };
  } catch {
    return fallback;
  }
}

let anthropicClient: Anthropic | null = null;

export async function classifyEmail(email: RawEmail): Promise<ClassifiedEmail> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildClassificationPrompt(email);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
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
