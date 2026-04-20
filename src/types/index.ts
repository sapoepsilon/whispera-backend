export const STEP_TYPES = ['llm', 'transform', 'conditional', 'api', 'output', 'transcribe', 'summarize'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export interface RecipeStep {
  type: StepType;
  name?: string;
  config: Record<string, unknown>;
}

export const PROVIDERS = ['claude', 'openai'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export const STORE_CATEGORIES = ['writing', 'coding', 'research', 'productivity', 'creative', 'analysis'] as const;
export type StoreCategory = (typeof STORE_CATEGORIES)[number];

export const STORE_STATUSES = ['published', 'unpublished', 'flagged', 'removed'] as const;
export type StoreRecipeStatus = (typeof STORE_STATUSES)[number];
