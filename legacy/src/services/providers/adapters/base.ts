import type {
  ProviderConfig,
  ChatMessage,
  ExtractedMessages,
  NormalizedFinishReason,
} from '../types.js';

const FINISH_REASON_MAP: Record<string, NormalizedFinishReason> = {
  end_turn: 'stop',
  stop: 'stop',
  max_tokens: 'length',
  length: 'length',
  tool_use: 'tool_use',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
};

export abstract class BaseProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  extractSystemMessage(messages: ChatMessage[]): ExtractedMessages {
    const systemMsg = messages.find((m) => m.role === 'system');
    const filtered = messages.filter((m) => m.role !== 'system');

    return {
      systemMessage: systemMsg?.content ?? null,
      messages: filtered,
    };
  }

  normalizeFinishReason(reason: string | null | undefined): NormalizedFinishReason {
    if (reason == null) return 'unknown';
    return FINISH_REASON_MAP[reason] ?? 'unknown';
  }
}
