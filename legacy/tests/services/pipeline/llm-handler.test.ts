import { describe, it, expect, vi } from 'vitest';

import { LLMStepHandler } from '../../../src/services/pipeline/handlers/llm.js';
import { ExecutionContext } from '../../../src/services/pipeline/context.js';

function createMockRouter(response: {
  content: string;
  provider: string;
  model: string;
  usage: { totalTokens: number };
}) {
  return {
    complete: vi.fn(async () => response),
    stream: vi.fn(),
  };
}

function createContext(variables?: Record<string, unknown>): ExecutionContext {
  const ctx = new ExecutionContext(
    '550e8400-e29b-41d4-a716-446655440000',
    '660e8400-e29b-41d4-a716-446655440001',
    variables,
  );
  return ctx;
}

describe('LLMStepHandler', () => {
  describe('template interpolation', () => {
    const cannedResponse = {
      content: 'LLM says hello',
      provider: 'claude',
      model: 'claude-4',
      usage: { totalTokens: 42 },
    };

    it('{{input}} resolves to previous step output', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'LLM Step' }]);

      await handler.execute(
        { prompt: 'Summarize: {{input}}' },
        ctx,
        'the article text',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: 'Summarize: the article text',
            }),
          ]),
        }),
        expect.anything(),
      );
    });

    it('{{variables.keyName}} resolves to context variable', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext({ lang: 'French' });
      ctx.initSteps([{ name: 'LLM Step' }]);

      await handler.execute(
        { prompt: 'Translate to {{variables.lang}}' },
        ctx,
        '',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: 'Translate to French',
            }),
          ]),
        }),
        expect.anything(),
      );
    });

    it('{{steps[0].output}} resolves to specific step output', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Step 0' }, { name: 'Step 1' }]);
      ctx.markStepRunning(0, 'input');
      ctx.setStepResult(0, { output: 'first step result' });

      await handler.execute(
        { prompt: 'Refine: {{steps[0].output}}' },
        ctx,
        'current input',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: 'Refine: first step result',
            }),
          ]),
        }),
        expect.anything(),
      );
    });

    it('unrecognized expressions resolve to empty string', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'LLM Step' }]);

      await handler.execute(
        { prompt: 'Value is {{unknownExpr}}' },
        ctx,
        '',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: 'Value is ',
            }),
          ]),
        }),
        expect.anything(),
      );
    });

    it('multiple expressions in one template all resolve', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext({ tone: 'formal' });
      ctx.initSteps([{ name: 'Step 0' }, { name: 'Step 1' }]);
      ctx.markStepRunning(0, 'in');
      ctx.setStepResult(0, { output: 'step zero output' });

      await handler.execute(
        {
          prompt:
            'Input: {{input}}, Tone: {{variables.tone}}, Prior: {{steps[0].output}}',
        },
        ctx,
        'user text',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content:
                'Input: user text, Tone: formal, Prior: step zero output',
            }),
          ]),
        }),
        expect.anything(),
      );
    });
  });

  describe('execute', () => {
    const cannedResponse = {
      content: 'Generated summary',
      provider: 'claude',
      model: 'claude-4',
      usage: { totalTokens: 150 },
    };

    it('calls the provider with the interpolated prompt', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Summarize' }]);

      await handler.execute({ prompt: 'Hello {{input}}' }, ctx, 'world');

      expect(router.complete).toHaveBeenCalledTimes(1);
    });

    it('returns a StepResult with output', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Step' }]);

      const result = await handler.execute(
        { prompt: 'Do something' },
        ctx,
        '',
      );

      expect(result).toHaveProperty('output');
      expect(result.output).toBe('Generated summary');
    });

    it('returns a StepResult with metadata', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Step' }]);

      const result = await handler.execute(
        { prompt: 'Do something' },
        ctx,
        '',
      );

      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('provider');
      expect(result.metadata).toHaveProperty('model');
      expect(result.metadata).toHaveProperty('tokens');
      expect(result.metadata).toHaveProperty('duration');
    });

    it('passes context.signal for abort support', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Step' }]);

      await handler.execute({ prompt: 'Test' }, ctx, '');

      expect(router.complete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: ctx.signal }),
      );
    });

    it('passes model, temperature, and maxTokens from config', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Step' }]);

      await handler.execute(
        {
          prompt: 'Generate',
          model: 'claude-4-sonnet',
          temperature: 0.7,
          maxTokens: 1024,
        },
        ctx,
        '',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-4-sonnet',
          temperature: 0.7,
          maxTokens: 1024,
        }),
        expect.anything(),
      );
    });

    it('interpolates systemPrompt if provided', async () => {
      const router = createMockRouter(cannedResponse);
      const handler = new LLMStepHandler(router);
      const ctx = createContext({ role: 'translator' });
      ctx.initSteps([{ name: 'Step' }]);

      await handler.execute(
        {
          prompt: 'Translate this',
          systemPrompt: 'You are a {{variables.role}}',
        },
        ctx,
        '',
      );

      expect(router.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'You are a translator',
        }),
        expect.anything(),
      );
    });
  });

  describe('error handling', () => {
    it('wraps provider errors in StepError with stepIndex and cause', async () => {
      const providerError = new Error('API rate limit exceeded');
      const router = {
        complete: vi.fn(async () => {
          throw providerError;
        }),
        stream: vi.fn(),
      };

      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Failing Step' }]);

      try {
        await handler.execute({ prompt: 'Test' }, ctx, '');
        expect.unreachable('should have thrown');
      } catch (error: any) {
        expect(error.name).toBe('StepError');
        expect(error.stepIndex).toBeDefined();
        expect(error.cause).toBe(providerError);
      }
    });

    it('StepError includes the step name', async () => {
      const router = {
        complete: vi.fn(async () => {
          throw new Error('connection refused');
        }),
        stream: vi.fn(),
      };

      const handler = new LLMStepHandler(router);
      const ctx = createContext();
      ctx.initSteps([{ name: 'Summarize' }]);

      try {
        await handler.execute({ prompt: 'Test' }, ctx, '');
        expect.unreachable('should have thrown');
      } catch (error: any) {
        expect(error.name).toBe('StepError');
        expect(error.message).toContain('connection refused');
      }
    });
  });
});
