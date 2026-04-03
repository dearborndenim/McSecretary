export interface RawEmail {
  id: string;
  account: string;
  sender: string;
  senderName: string;
  subject: string;
  bodyPreview: string;
  body: string;
  receivedAt: string;
  threadId: string;
  isRead: boolean;
}

export interface ClassifiedEmail extends RawEmail {
  category: string;
  urgency: string;
  actionNeeded: string;
  confidence: number;
  summary: string;
  suggestedAction: string;
  senderImportance: string;
}
