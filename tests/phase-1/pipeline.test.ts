import { describe, it, expect, vi } from 'vitest';

import {
  PipelineExecutor,
  StepHandlerRegistry,
  StepType,
} from '../../src/services/pipeline/index.js';

import type { StepHandler, StepDefinition, PipelineResult } from '../../src/services/pipeline/index.js';

function createPassthroughHandler(output: unknown): StepHandler {
  return {
    execute: vi.fn(async () => output),
  };
}

function createFailingHandler(error: string): StepHandler {
  return {
    execute: vi.fn(async () => {
      throw new Error(error);
    }),
  };
}

function createSlowHandler(output: unknown, delayMs: number): StepHandler {
  return {
    execute: vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(output), delayMs)),
    ),
  };
}

describe('StepHandlerRegistry', () => {
  it('registers a handler and retrieves it', () => {
    const registry = new StepHandlerRegistry();
    const handler = createPassthroughHandler('result');

    registry.register('transcribe' as StepType, handler);

    expect(registry.get('transcribe' as StepType)).toBe(handler);
  });

  it('throws when getting an unregistered type', () => {
    const registry = new StepHandlerRegistry();

    expect(() => registry.get('nonexistent' as StepType)).toThrow();
  });

  it('throws on duplicate registration', () => {
    const registry = new StepHandlerRegistry();
    const handler = createPassthroughHandler('result');

    registry.register('transcribe' as StepType, handler);

    expect(() =>
      registry.register('transcribe' as StepType, handler),
    ).toThrow();
  });

  it('has() returns true for registered types', () => {
    const registry = new StepHandlerRegistry();
    const handler = createPassthroughHandler('result');

    registry.register('transcribe' as StepType, handler);

    expect(registry.has('transcribe' as StepType)).toBe(true);
  });

  it('has() returns false for unregistered types', () => {
    const registry = new StepHandlerRegistry();

    expect(registry.has('nonexistent' as StepType)).toBe(false);
  });

  it('registeredTypes() returns all registered types', () => {
    const registry = new StepHandlerRegistry();

    registry.register('transcribe' as StepType, createPassthroughHandler('a'));
    registry.register('summarize' as StepType, createPassthroughHandler('b'));

    const types = registry.registeredTypes();
    expect(types).toContain('transcribe');
    expect(types).toContain('summarize');
    expect(types).toHaveLength(2);
  });
});

describe('PipelineExecutor', () => {
  it('executes steps sequentially, passing output as next input', async () => {
    const registry = new StepHandlerRegistry();

    const step1Handler = createPassthroughHandler('step1-output');
    const step2Handler: StepHandler = {
      execute: vi.fn(async (input) => `received:${input}`),
    };

    registry.register('transcribe' as StepType, step1Handler);
    registry.register('summarize' as StepType, step2Handler);

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {} },
      { type: 'summarize' as StepType, config: {} },
    ];

    const result = await executor.execute(steps, 'initial-input');

    expect(step2Handler.execute).toHaveBeenCalledWith(
      'step1-output',
      expect.anything(),
    );
    expect(result.finalOutput).toBe('received:step1-output');
  });

  it('returns a PipelineResult with correct structure', async () => {
    const registry = new StepHandlerRegistry();
    registry.register(
      'transcribe' as StepType,
      createPassthroughHandler('output'),
    );

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {} },
    ];

    const result: PipelineResult = await executor.execute(steps, 'input');

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('finalOutput');
    expect(result).toHaveProperty('stepResults');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.stepResults)).toBe(true);
  });

  it('aborts on non-optional step failure', async () => {
    const registry = new StepHandlerRegistry();

    registry.register(
      'transcribe' as StepType,
      createFailingHandler('step failed'),
    );
    registry.register(
      'summarize' as StepType,
      createPassthroughHandler('should-not-run'),
    );

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {}, optional: false },
      { type: 'summarize' as StepType, config: {} },
    ];

    const result = await executor.execute(steps, 'input');

    expect(result.success).toBe(false);
    expect(result.stepResults).toHaveLength(1);
  });

  it('continues execution when an optional step fails', async () => {
    const registry = new StepHandlerRegistry();

    registry.register(
      'transcribe' as StepType,
      createFailingHandler('optional failure'),
    );
    registry.register(
      'summarize' as StepType,
      createPassthroughHandler('final-output'),
    );

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {}, optional: true },
      { type: 'summarize' as StepType, config: {} },
    ];

    const result = await executor.execute(steps, 'input');

    expect(result.success).toBe(true);
    expect(result.finalOutput).toBe('final-output');
  });

  it('rejects a step that exceeds timeoutMs', async () => {
    const registry = new StepHandlerRegistry();

    registry.register(
      'transcribe' as StepType,
      createSlowHandler('too-late', 5000),
    );

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {}, timeoutMs: 50 },
    ];

    const result = await executor.execute(steps, 'input');

    expect(result.success).toBe(false);
    expect(result.stepResults[0]?.error).toBeDefined();
  });

  it('cancels execution via AbortSignal', async () => {
    const registry = new StepHandlerRegistry();

    registry.register(
      'transcribe' as StepType,
      createSlowHandler('too-late', 5000),
    );

    const executor = new PipelineExecutor(registry);
    const controller = new AbortController();

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {} },
    ];

    setTimeout(() => controller.abort(), 50);

    const result = await executor.execute(steps, 'input', {
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
  });

  it('finalOutput is the last successful step output', async () => {
    const registry = new StepHandlerRegistry();

    registry.register('transcribe' as StepType, createPassthroughHandler('a'));
    registry.register('summarize' as StepType, createPassthroughHandler('b'));
    registry.register('translate' as StepType, createPassthroughHandler('c'));

    const executor = new PipelineExecutor(registry);

    const steps: StepDefinition[] = [
      { type: 'transcribe' as StepType, config: {} },
      { type: 'summarize' as StepType, config: {} },
      { type: 'translate' as StepType, config: {} },
    ];

    const result = await executor.execute(steps, 'input');

    expect(result.finalOutput).toBe('c');
  });

  it('returns success with null finalOutput for empty steps', async () => {
    const registry = new StepHandlerRegistry();
    const executor = new PipelineExecutor(registry);

    const result = await executor.execute([], 'input');

    expect(result.success).toBe(true);
    expect(result.finalOutput).toBeNull();
  });
});
