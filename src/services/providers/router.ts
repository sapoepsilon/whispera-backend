import type { ProviderConfig } from './types.js';
import { BaseProvider } from './adapters/base.js';
import { ClaudeProvider } from './adapters/claude.js';
import { OpenAIProvider } from './adapters/openai.js';
import type { ProviderName } from '../../types/index.js';

const PROVIDER_FACTORIES: Record<ProviderName, new (config: ProviderConfig) => BaseProvider> = {
  claude: ClaudeProvider,
  openai: OpenAIProvider,
};

export class ProviderRouter {
  private cache = new Map<string, BaseProvider>();

  getProvider(name: string, config: ProviderConfig): BaseProvider {
    const Factory = PROVIDER_FACTORIES[name as ProviderName];
    if (!Factory) {
      throw new Error(`Unknown provider: ${name}`);
    }

    const cacheKey = `${name}:${config.apiKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instance = new Factory(config);
    this.cache.set(cacheKey, instance);
    return instance;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
