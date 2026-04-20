import { describe, it, expect, beforeEach } from 'vitest';

import { ExecutionContext } from '../../src/services/pipeline/context.js';
import { UUID_REGEX } from '../../helpers.js';

describe('ExecutionContext', () => {
  const recipeId = '550e8400-e29b-41d4-a716-446655440000';
  const userId = '660e8400-e29b-41d4-a716-446655440001';

  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = new ExecutionContext(recipeId, userId);
  });

  describe('constructor', () => {
    it('sets executionId as a valid UUID', () => {
      expect(ctx.executionId).toMatch(UUID_REGEX);
    });

    it('sets recipeId from constructor argument', () => {
      expect(ctx.recipeId).toBe(recipeId);
    });

    it('sets userId from constructor argument', () => {
      expect(ctx.userId).toBe(userId);
    });

    it('sets startedAt to a Date', () => {
      expect(ctx.startedAt).toBeInstanceOf(Date);
    });

    it('sets status to "running"', () => {
      expect(ctx.status).toBe('running');
    });

    it('generates a unique executionId for each instance', () => {
      const other = new ExecutionContext(recipeId, userId);
      expect(ctx.executionId).not.toBe(other.executionId);
    });

    it('accepts optional initialVariables', () => {
      const variables = { lang: 'en', topic: 'testing' };
      const ctxWithVars = new ExecutionContext(recipeId, userId, variables);
      expect(ctxWithVars.getVariable('lang')).toBe('en');
      expect(ctxWithVars.getVariable('topic')).toBe('testing');
    });
  });

  describe('initSteps', () => {
    it('creates the correct number of StepState entries', () => {
      ctx.initSteps([{ name: 'Step 1' }, { name: 'Step 2' }, { name: 'Step 3' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps).toHaveLength(3);
    });

    it('sets all steps to "pending" status', () => {
      ctx.initSteps([{ name: 'A' }, { name: 'B' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps.every((s) => s.status === 'pending')).toBe(true);
    });

    it('assigns stepIndex to each step', () => {
      ctx.initSteps([{ name: 'A' }, { name: 'B' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].stepIndex).toBe(0);
      expect(snapshot.steps[1].stepIndex).toBe(1);
    });

    it('assigns stepName from the definitions', () => {
      ctx.initSteps([{ name: 'Fetch' }, { name: 'Summarize' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].stepName).toBe('Fetch');
      expect(snapshot.steps[1].stepName).toBe('Summarize');
    });

    it('initializes input and output as null', () => {
      ctx.initSteps([{ name: 'Step' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].input).toBeNull();
      expect(snapshot.steps[0].output).toBeNull();
    });

    it('initializes timestamps as null', () => {
      ctx.initSteps([{ name: 'Step' }]);
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].startedAt).toBeNull();
      expect(snapshot.steps[0].completedAt).toBeNull();
    });
  });

  describe('markStepRunning', () => {
    beforeEach(() => {
      ctx.initSteps([{ name: 'Step 0' }, { name: 'Step 1' }]);
    });

    it('sets the step status to "running"', () => {
      ctx.markStepRunning(0, 'some input');
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].status).toBe('running');
    });

    it('records the input', () => {
      ctx.markStepRunning(0, { text: 'hello' });
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].input).toEqual({ text: 'hello' });
    });

    it('records startedAt as an ISO string', () => {
      ctx.markStepRunning(0, 'input');
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].startedAt).toBeDefined();
      expect(typeof snapshot.steps[0].startedAt).toBe('string');
      expect(new Date(snapshot.steps[0].startedAt!).toISOString()).toBe(
        snapshot.steps[0].startedAt,
      );
    });
  });

  describe('setStepResult', () => {
    beforeEach(() => {
      ctx.initSteps([{ name: 'Step 0' }]);
      ctx.markStepRunning(0, 'input');
    });

    it('sets the step status to "completed"', () => {
      ctx.setStepResult(0, { output: 'result' });
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].status).toBe('completed');
    });

    it('records the output', () => {
      ctx.setStepResult(0, { output: 'the output' });
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].output).toBe('the output');
    });

    it('accumulates metadata tokens', () => {
      ctx.setStepResult(0, {
        output: 'result',
        metadata: { totalTokens: 100, totalDuration: 500 },
      });
      const snapshot = ctx.toJSON();
      expect(snapshot.metadata.totalTokens).toBe(100);
    });

    it('accumulates metadata duration', () => {
      ctx.setStepResult(0, {
        output: 'result',
        metadata: { totalTokens: 50, totalDuration: 200 },
      });
      const snapshot = ctx.toJSON();
      expect(snapshot.metadata.totalDuration).toBe(200);
    });

    it('accumulates metadata across multiple steps', () => {
      ctx.initSteps([{ name: 'A' }, { name: 'B' }]);
      ctx.markStepRunning(0, 'in');
      ctx.setStepResult(0, {
        output: 'out1',
        metadata: { totalTokens: 100, totalDuration: 300 },
      });
      ctx.markStepRunning(1, 'in2');
      ctx.setStepResult(1, {
        output: 'out2',
        metadata: { totalTokens: 50, totalDuration: 200 },
      });
      const snapshot = ctx.toJSON();
      expect(snapshot.metadata.totalTokens).toBe(150);
      expect(snapshot.metadata.totalDuration).toBe(500);
    });

    it('updates provider and model from metadata', () => {
      ctx.setStepResult(0, {
        output: 'result',
        metadata: { provider: 'claude', model: 'claude-4' },
      });
      const snapshot = ctx.toJSON();
      expect(snapshot.metadata.provider).toBe('claude');
      expect(snapshot.metadata.model).toBe('claude-4');
    });
  });

  describe('setStepError', () => {
    beforeEach(() => {
      ctx.initSteps([{ name: 'Failing Step' }]);
      ctx.markStepRunning(0, 'input');
    });

    it('sets the step status to "failed"', () => {
      ctx.setStepError(0, 'something went wrong');
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].status).toBe('failed');
    });

    it('records the error message', () => {
      ctx.setStepError(0, 'timeout exceeded');
      const snapshot = ctx.toJSON();
      expect(snapshot.steps[0].error).toBe('timeout exceeded');
    });
  });

  describe('getStepOutput', () => {
    beforeEach(() => {
      ctx.initSteps([{ name: 'Step 0' }]);
      ctx.markStepRunning(0, 'input');
      ctx.setStepResult(0, { output: 'completed output' });
    });

    it('returns output for a completed step', () => {
      expect(ctx.getStepOutput(0)).toBe('completed output');
    });

    it('throws for an out-of-range index (negative)', () => {
      expect(() => ctx.getStepOutput(-1)).toThrow();
    });

    it('throws for an out-of-range index (too high)', () => {
      expect(() => ctx.getStepOutput(99)).toThrow();
    });
  });

  describe('setVariable / getVariable', () => {
    it('sets and retrieves a string variable', () => {
      ctx.setVariable('lang', 'en');
      expect(ctx.getVariable('lang')).toBe('en');
    });

    it('sets and retrieves an object variable', () => {
      ctx.setVariable('config', { nested: true });
      expect(ctx.getVariable('config')).toEqual({ nested: true });
    });

    it('returns undefined for an unset variable', () => {
      expect(ctx.getVariable('nonexistent')).toBeUndefined();
    });

    it('overwrites an existing variable', () => {
      ctx.setVariable('count', 1);
      ctx.setVariable('count', 2);
      expect(ctx.getVariable('count')).toBe(2);
    });
  });

  describe('complete', () => {
    it('sets status to "completed"', () => {
      ctx.complete();
      expect(ctx.status).toBe('completed');
    });

    it('records completedAt', () => {
      ctx.complete();
      const snapshot = ctx.toJSON();
      expect(snapshot.completedAt).toBeDefined();
      expect(typeof snapshot.completedAt).toBe('string');
    });
  });

  describe('fail', () => {
    it('sets status to "failed"', () => {
      ctx.fail('something broke');
      expect(ctx.status).toBe('failed');
    });

    it('records the error message', () => {
      ctx.fail('out of memory');
      const snapshot = ctx.toJSON();
      expect(snapshot.error).toBe('out of memory');
    });

    it('records completedAt', () => {
      ctx.fail('error');
      const snapshot = ctx.toJSON();
      expect(snapshot.completedAt).toBeDefined();
      expect(typeof snapshot.completedAt).toBe('string');
    });
  });

  describe('abort', () => {
    it('sets status to "aborted"', () => {
      ctx.abort();
      expect(ctx.status).toBe('aborted');
    });

    it('triggers the AbortController signal', () => {
      expect(ctx.signal.aborted).toBe(false);
      ctx.abort();
      expect(ctx.signal.aborted).toBe(true);
    });

    it('records completedAt', () => {
      ctx.abort();
      const snapshot = ctx.toJSON();
      expect(snapshot.completedAt).toBeDefined();
    });
  });

  describe('toJSON', () => {
    it('returns a snapshot with all expected fields', () => {
      ctx.initSteps([{ name: 'Step' }]);
      ctx.setVariable('key', 'value');
      const snapshot = ctx.toJSON();

      expect(snapshot).toHaveProperty('executionId');
      expect(snapshot).toHaveProperty('recipeId');
      expect(snapshot).toHaveProperty('userId');
      expect(snapshot).toHaveProperty('status');
      expect(snapshot).toHaveProperty('steps');
      expect(snapshot).toHaveProperty('variables');
      expect(snapshot).toHaveProperty('metadata');
      expect(snapshot).toHaveProperty('startedAt');
      expect(snapshot).toHaveProperty('completedAt');
      expect(snapshot).toHaveProperty('error');
    });

    it('returns startedAt as an ISO string', () => {
      const snapshot = ctx.toJSON();
      expect(typeof snapshot.startedAt).toBe('string');
      expect(new Date(snapshot.startedAt).toISOString()).toBe(snapshot.startedAt);
    });

    it('returns an immutable deep copy (mutating steps does not affect context)', () => {
      ctx.initSteps([{ name: 'Step' }]);
      const snapshot1 = ctx.toJSON();
      snapshot1.steps[0].status = 'failed';
      snapshot1.steps.push({
        stepIndex: 99,
        stepName: 'injected',
        status: 'pending',
        input: null,
        output: null,
        startedAt: null,
        completedAt: null,
      });

      const snapshot2 = ctx.toJSON();
      expect(snapshot2.steps).toHaveLength(1);
      expect(snapshot2.steps[0].status).toBe('pending');
    });

    it('returns an immutable deep copy (mutating variables does not affect context)', () => {
      ctx.setVariable('key', 'original');
      const snapshot1 = ctx.toJSON();
      snapshot1.variables['key'] = 'tampered';
      snapshot1.variables['extra'] = 'injected';

      const snapshot2 = ctx.toJSON();
      expect(snapshot2.variables['key']).toBe('original');
      expect(snapshot2.variables['extra']).toBeUndefined();
    });

    it('returns an immutable deep copy (mutating metadata does not affect context)', () => {
      const snapshot1 = ctx.toJSON();
      snapshot1.metadata.totalTokens = 999999;

      const snapshot2 = ctx.toJSON();
      expect(snapshot2.metadata.totalTokens).toBe(0);
    });
  });
});
