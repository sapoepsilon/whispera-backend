import { describe, it, expect } from 'vitest';

import {
  ProviderRouter,
  ClaudeProvider,
  OpenAIProvider,
} from '../../src/services/providers/index.js';

describe('ProviderRouter', () => {
  it('returns a ClaudeProvider for provider name "claude"', () => {
    const router = new ProviderRouter();
    const provider = router.getProvider('claude', { apiKey: 'sk-test-key' });

    expect(provider).toBeInstanceOf(ClaudeProvider);
  });

  it('returns an OpenAIProvider for provider name "openai"', () => {
    const router = new ProviderRouter();
    const provider = router.getProvider('openai', { apiKey: 'sk-test-key' });

    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('caches provider instances by provider + apiKey', () => {
    const router = new ProviderRouter();

    const first = router.getProvider('claude', { apiKey: 'sk-key-1' });
    const second = router.getProvider('claude', { apiKey: 'sk-key-1' });

    expect(first).toBe(second);
  });

  it('returns different instances for different apiKeys', () => {
    const router = new ProviderRouter();

    const first = router.getProvider('claude', { apiKey: 'sk-key-1' });
    const second = router.getProvider('claude', { apiKey: 'sk-key-2' });

    expect(first).not.toBe(second);
  });

  it('returns different instances for different providers', () => {
    const router = new ProviderRouter();

    const claude = router.getProvider('claude', { apiKey: 'sk-key-1' });
    const openai = router.getProvider('openai', { apiKey: 'sk-key-1' });

    expect(claude).not.toBe(openai);
  });

  it('clears cached providers with clearCache()', () => {
    const router = new ProviderRouter();

    const before = router.getProvider('claude', { apiKey: 'sk-key-1' });
    router.clearCache();
    const after = router.getProvider('claude', { apiKey: 'sk-key-1' });

    expect(before).not.toBe(after);
  });

  it('throws for an unknown provider name', () => {
    const router = new ProviderRouter();

    expect(() =>
      router.getProvider('unknown-provider', { apiKey: 'sk-key' }),
    ).toThrow();
  });
});

describe('BaseProvider (via concrete implementations)', () => {
  describe('extractSystemMessage', () => {
    it('separates system messages from user/assistant messages', () => {
      const provider = new ClaudeProvider({ apiKey: 'sk-test' });

      const messages = [
        { role: 'system' as const, content: 'You are a helpful assistant.' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];

      const result = provider.extractSystemMessage(messages);

      expect(result.systemMessage).toBe('You are a helpful assistant.');
      expect(result.messages).toHaveLength(2);
      expect(result.messages.every((m) => m.role !== 'system')).toBe(true);
    });

    it('returns null systemMessage when no system message exists', () => {
      const provider = new ClaudeProvider({ apiKey: 'sk-test' });

      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi!' },
      ];

      const result = provider.extractSystemMessage(messages);

      expect(result.systemMessage).toBeNull();
      expect(result.messages).toHaveLength(2);
    });
  });

  describe('normalizeFinishReason', () => {
    it('maps Claude "end_turn" to "stop"', () => {
      const provider = new ClaudeProvider({ apiKey: 'sk-test' });

      expect(provider.normalizeFinishReason('end_turn')).toBe('stop');
    });

    it('maps Claude "max_tokens" to "length"', () => {
      const provider = new ClaudeProvider({ apiKey: 'sk-test' });

      expect(provider.normalizeFinishReason('max_tokens')).toBe('length');
    });

    it('maps OpenAI "stop" to "stop"', () => {
      const provider = new OpenAIProvider({ apiKey: 'sk-test' });

      expect(provider.normalizeFinishReason('stop')).toBe('stop');
    });

    it('maps OpenAI "length" to "length"', () => {
      const provider = new OpenAIProvider({ apiKey: 'sk-test' });

      expect(provider.normalizeFinishReason('length')).toBe('length');
    });

    it('maps unknown reasons to "unknown"', () => {
      const provider = new ClaudeProvider({ apiKey: 'sk-test' });

      expect(provider.normalizeFinishReason('something_unexpected')).toBe(
        'unknown',
      );
    });
  });
});
