import type { StepDefinition, StepResult, PipelineResult, ExecuteOptions } from './types.js';
import type { StepHandlerRegistry } from './registry.js';

export class PipelineExecutor {
  constructor(
    private registry: StepHandlerRegistry,
    private defaultTimeoutMs?: number,
  ) {}

  async execute(
    steps: StepDefinition[],
    input: unknown,
    options?: ExecuteOptions,
  ): Promise<PipelineResult> {
    const start = Date.now();
    const stepResults: StepResult[] = [];
    let currentInput = input;
    let lastSuccessfulOutput: unknown = null;

    for (const step of steps) {
      if (options?.signal?.aborted) {
        return {
          success: false,
          finalOutput: lastSuccessfulOutput,
          stepResults,
          totalDurationMs: Date.now() - start,
        };
      }

      const handler = this.registry.get(step.type);
      const stepStart = Date.now();

      try {
        const output = await this.executeWithConstraints(
          () => handler.execute(currentInput, step.config),
          step.timeoutMs ?? this.defaultTimeoutMs,
          options?.signal,
        );

        const result: StepResult = {
          stepType: step.type,
          success: true,
          output,
          durationMs: Date.now() - stepStart,
        };

        stepResults.push(result);
        currentInput = output;
        lastSuccessfulOutput = output;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const result: StepResult = {
          stepType: step.type,
          success: false,
          output: null,
          error,
          durationMs: Date.now() - stepStart,
        };

        stepResults.push(result);

        if (!step.optional) {
          return {
            success: false,
            finalOutput: lastSuccessfulOutput,
            stepResults,
            totalDurationMs: Date.now() - start,
          };
        }
      }
    }

    return {
      success: true,
      finalOutput: lastSuccessfulOutput,
      stepResults,
      totalDurationMs: Date.now() - start,
    };
  }

  private executeWithConstraints(
    fn: () => Promise<unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const promises: Promise<unknown>[] = [fn()];

    if (timeoutMs !== undefined) {
      promises.push(
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      );
    }

    if (signal) {
      promises.push(
        new Promise((_, reject) => {
          if (signal.aborted) {
            reject(new Error('Pipeline aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('Pipeline aborted')), {
            once: true,
          });
        }),
      );
    }

    return Promise.race(promises);
  }
}
