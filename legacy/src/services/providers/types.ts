export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  organizationId?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ExtractedMessages {
  systemMessage: string | null;
  messages: ChatMessage[];
}

export type NormalizedFinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'unknown';
