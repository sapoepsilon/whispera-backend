import type { ExecutionContext } from '../context.js';

interface LLMStepConfig {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  usage: { totalTokens: number };
}

interface Router {
  complete(request: Record<string, unknown>, options: { signal: AbortSignal }): Promise<LLMResponse>;
}

interface StepResultOutput {
  output: string;
  metadata: {
    provider: string;
    model: string;
    tokens: number;
    duration: number;
  };
}

export class StepError extends Error {
  override name = 'StepError';
  stepIndex: number;
  override cause: Error;

  constructor(message: string, stepIndex: number, cause: Error) {
    super(message);
    this.stepIndex = stepIndex;
    this.cause = cause;
  }
}

export class LLMStepHandler {
  private router: Router;

  constructor(router: Router) {
    this.router = router;
  }

  async execute(
    config: LLMStepConfig,
    ctx: ExecutionContext,
    previousOutput: unknown,
  ): Promise<StepResultOutput> {
    const prompt = this.interpolate(config.prompt, ctx, previousOutput);
    const systemPrompt = config.systemPrompt
      ? this.interpolate(config.systemPrompt, ctx, previousOutput)
      : undefined;

    const request: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
    };

    if (config.model !== undefined) request.model = config.model;
    if (config.temperature !== undefined) request.temperature = config.temperature;
    if (config.maxTokens !== undefined) request.maxTokens = config.maxTokens;
    if (systemPrompt !== undefined) request.systemPrompt = systemPrompt;

    const start = Date.now();

    try {
      const response = await this.router.complete(request, { signal: ctx.signal });
      const duration = Date.now() - start;

      return {
        output: response.content,
        metadata: {
          provider: response.provider,
          model: response.model,
          tokens: response.usage.totalTokens,
          duration,
        },
      };
    } catch (err) {
      const snapshot = ctx.toJSON();
      const runningStep = snapshot.steps.find((s) => s.status === 'running');
      const stepIndex = runningStep?.stepIndex ?? 0;
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new StepError(cause.message, stepIndex, cause);
    }
  }

  private interpolate(template: string, ctx: ExecutionContext, previousOutput: unknown): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_match, expr: string) => {
      const trimmed = expr.trim();

      if (trimmed === 'input') {
        return String(previousOutput ?? '');
      }

      const variableMatch = trimmed.match(/^variables\.(.+)$/);
      if (variableMatch) {
        const value = ctx.getVariable(variableMatch[1]);
        return value !== undefined ? String(value) : '';
      }

      const stepMatch = trimmed.match(/^steps\[(\d+)\]\.output$/);
      if (stepMatch) {
        const output = ctx.getStepOutput(Number(stepMatch[1]));
        return output !== undefined ? String(output) : '';
      }

      return '';
    });
  }
}
