export type StepType = string & { readonly __brand?: unique symbol };

export interface StepHandler {
  execute(input: unknown, config: Record<string, unknown>): Promise<unknown>;
}

export interface StepDefinition {
  type: StepType;
  config: Record<string, unknown>;
  optional?: boolean;
  timeoutMs?: number;
}

export interface StepResult {
  stepType: StepType;
  success: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}

export interface PipelineResult {
  success: boolean;
  finalOutput: unknown;
  stepResults: StepResult[];
  totalDurationMs: number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}
