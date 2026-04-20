import { randomUUID } from 'node:crypto';

type StepStatus = 'pending' | 'running' | 'completed' | 'failed';
type ExecutionStatus = 'running' | 'completed' | 'failed' | 'aborted';

interface StepState {
  stepIndex: number;
  stepName: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error?: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface ExecutionMetadata {
  totalTokens: number;
  totalDuration: number;
  provider?: string;
  model?: string;
}

interface ExecutionSnapshot {
  executionId: string;
  recipeId: string;
  userId: string;
  status: ExecutionStatus;
  steps: StepState[];
  variables: Record<string, unknown>;
  metadata: ExecutionMetadata;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export class ExecutionContext {
  readonly executionId: string;
  readonly recipeId: string;
  readonly userId: string;
  readonly startedAt: Date;
  status: ExecutionStatus;
  readonly signal: AbortSignal;

  private abortController: AbortController;
  private steps: StepState[] = [];
  private variables: Record<string, unknown> = {};
  private metadata: ExecutionMetadata = { totalTokens: 0, totalDuration: 0 };
  private completedAt: Date | null = null;
  private error: string | null = null;

  constructor(recipeId: string, userId: string, initialVariables?: Record<string, unknown>) {
    this.executionId = randomUUID();
    this.recipeId = recipeId;
    this.userId = userId;
    this.startedAt = new Date();
    this.status = 'running';
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;

    if (initialVariables) {
      this.variables = { ...initialVariables };
    }
  }

  initSteps(definitions: Array<{ name: string }>): void {
    this.steps = definitions.map((def, index) => ({
      stepIndex: index,
      stepName: def.name,
      status: 'pending',
      input: null,
      output: null,
      startedAt: null,
      completedAt: null,
    }));
  }

  markStepRunning(index: number, input: unknown): void {
    const step = this.getStep(index);
    step.status = 'running';
    step.input = input;
    step.startedAt = new Date().toISOString();
  }

  setStepResult(index: number, result: {
    output: unknown;
    metadata?: {
      totalTokens?: number;
      totalDuration?: number;
      provider?: string;
      model?: string;
    };
  }): void {
    const step = this.getStep(index);
    step.status = 'completed';
    step.output = result.output;
    step.completedAt = new Date().toISOString();

    if (result.metadata) {
      if (result.metadata.totalTokens !== undefined) {
        this.metadata.totalTokens += result.metadata.totalTokens;
      }
      if (result.metadata.totalDuration !== undefined) {
        this.metadata.totalDuration += result.metadata.totalDuration;
      }
      if (result.metadata.provider !== undefined) {
        this.metadata.provider = result.metadata.provider;
      }
      if (result.metadata.model !== undefined) {
        this.metadata.model = result.metadata.model;
      }
    }
  }

  setStepError(index: number, error: string): void {
    const step = this.getStep(index);
    step.status = 'failed';
    step.error = error;
    step.completedAt = new Date().toISOString();
  }

  getStepOutput(index: number): unknown {
    const step = this.getStep(index);
    return step.output;
  }

  setVariable(key: string, value: unknown): void {
    this.variables[key] = value;
  }

  getVariable(key: string): unknown {
    return this.variables[key];
  }

  complete(): void {
    this.status = 'completed';
    this.completedAt = new Date();
  }

  fail(message: string): void {
    this.status = 'failed';
    this.error = message;
    this.completedAt = new Date();
  }

  abort(): void {
    this.status = 'aborted';
    this.completedAt = new Date();
    this.abortController.abort();
  }

  toJSON(): ExecutionSnapshot {
    return structuredClone({
      executionId: this.executionId,
      recipeId: this.recipeId,
      userId: this.userId,
      status: this.status,
      steps: this.steps,
      variables: this.variables,
      metadata: this.metadata,
      startedAt: this.startedAt.toISOString(),
      completedAt: this.completedAt?.toISOString() ?? null,
      error: this.error,
    });
  }

  private getStep(index: number): StepState {
    if (index < 0 || index >= this.steps.length) {
      throw new RangeError(`Step index ${index} out of range [0, ${this.steps.length})`);
    }
    return this.steps[index];
  }
}
