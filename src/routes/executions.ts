import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { RecipeService } from '../services/recipes/index.js';
import { ExecutionService } from '../services/execution.service.js';
import { ExecutionContext } from '../services/pipeline/context.js';
import { StepHandlerRegistry } from '../services/pipeline/registry.js';
import type { StepType } from '../services/pipeline/types.js';
import { UUID_REGEX } from '../utils/validation.js';

const executeSchema = z.object({
  input: z.string().optional().default(''),
  stream: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.unknown()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

function createRegistry(): StepHandlerRegistry {
  const registry = new StepHandlerRegistry();

  registry.register('llm' as StepType, {
    async execute(input: unknown, config: Record<string, unknown>) {
      const provider = String(config.provider ?? 'openai');
      const apiKey = String(config.apiKey ?? '');

      if (!apiKey) {
        throw new Error('No API key provided for LLM step');
      }

      const prompt = String(config.prompt ?? '').replace(
        /\{\{input\}\}/g,
        String(input ?? ''),
      );

      if (provider === 'claude') {
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: String(config.model ?? 'claude-sonnet-4-20250514'),
          max_tokens: Number(config.maxTokens ?? 1024),
          messages: [{ role: 'user', content: prompt }],
        });

        return response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
      }

      const client = new OpenAI({ apiKey });
      const completion = await client.chat.completions.create({
        model: String(config.model ?? 'gpt-4o'),
        messages: [{ role: 'user', content: prompt }],
      });

      return completion.choices[0]?.message?.content ?? '';
    },
  });

  return registry;
}

async function runPipeline(
  ctx: ExecutionContext,
  registry: StepHandlerRegistry,
  steps: Array<{ type: string; name: string; config: Record<string, unknown> }>,
  input: string,
  onStepStart?: (index: number, name: string) => void,
  onStepComplete?: (index: number, name: string, output: unknown) => void,
) {
  ctx.initSteps(steps);
  let currentInput: unknown = input;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    ctx.markStepRunning(i, currentInput);
    onStepStart?.(i, step.name);

    try {
      const handler = registry.get(step.type as StepType);
      const output = await handler.execute(currentInput, step.config);

      ctx.setStepResult(i, { output });
      currentInput = output;
      onStepComplete?.(i, step.name, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.setStepError(i, message);
      ctx.fail(message);
      return;
    }
  }

  ctx.complete();
}

export default async function executionRoutes(app: FastifyInstance) {
  const recipeService = new RecipeService(app.db);
  const executionService = new ExecutionService(app.db);
  const registry = createRegistry();

  app.post(
    '/recipes/:id/execute',
    { preHandler: [app.authenticate] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid recipe ID' });
      }

      const recipe = await recipeService.findByIdAndUser(id, request.userId);
      if (!recipe) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      const result = executeSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: result.error.issues,
        });
      }

      const { input, stream, variables } = result.data;
      const steps = recipe.steps as Array<{
        type: string;
        name: string;
        config: Record<string, unknown>;
      }>;

      const ctx = new ExecutionContext(recipe.id, request.userId, variables);

      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const write = (event: string, data: unknown) => {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        await runPipeline(
          ctx,
          registry,
          steps,
          input,
          (index, name) => {
            write('step:start', { stepIndex: index, stepName: name });
          },
          (index, name, output) => {
            write('step:complete', {
              stepIndex: index,
              stepName: name,
              output,
            });
          },
        );

        const snapshot = ctx.toJSON();
        write('execution:complete', {
          executionId: snapshot.executionId,
          status: snapshot.status,
        });

        await executionService.save({
          id: snapshot.executionId,
          recipeId: recipe.id,
          userId: request.userId,
          status: snapshot.status,
          steps: snapshot.steps,
          variables: snapshot.variables,
          metadata: snapshot.metadata,
          error: snapshot.error,
          startedAt: new Date(snapshot.startedAt),
          completedAt: snapshot.completedAt
            ? new Date(snapshot.completedAt)
            : null,
        });

        reply.raw.end();
        return reply;
      }

      await runPipeline(ctx, registry, steps, input);
      const snapshot = ctx.toJSON();

      await executionService.save({
        id: snapshot.executionId,
        recipeId: recipe.id,
        userId: request.userId,
        status: snapshot.status,
        steps: snapshot.steps,
        variables: snapshot.variables,
        metadata: snapshot.metadata,
        error: snapshot.error,
        startedAt: new Date(snapshot.startedAt),
        completedAt: snapshot.completedAt
          ? new Date(snapshot.completedAt)
          : null,
      });

      const lastCompletedStep = [...snapshot.steps]
        .reverse()
        .find((s) => s.status === 'completed');

      return reply.code(200).send({
        executionId: snapshot.executionId,
        status: snapshot.status,
        steps: snapshot.steps,
        output: lastCompletedStep?.output ?? null,
        error: snapshot.error ?? undefined,
      });
    },
  );

  app.get(
    '/recipes/:id/executions',
    { preHandler: [app.authenticate] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid recipe ID' });
      }

      const recipe = await recipeService.findByIdAndUser(id, request.userId);
      if (!recipe) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      const queryResult = listQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: queryResult.error.issues,
        });
      }

      const { page, limit } = queryResult.data;
      const list = await executionService.listByRecipe(id, request.userId, {
        page,
        limit,
      });

      return reply.code(200).send(list);
    },
  );

  app.get(
    '/executions/:id',
    { preHandler: [app.authenticate] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid execution ID' });
      }

      const execution = await executionService.getByIdAndUserId(
        id,
        request.userId,
      );
      if (!execution) {
        return reply.code(404).send({ error: 'Execution not found' });
      }

      return reply.code(200).send({ data: execution });
    },
  );
}
