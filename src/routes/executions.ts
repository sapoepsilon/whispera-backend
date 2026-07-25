import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { RecipeService } from '../services/recipes/index.js';
import { ExecutionService } from '../services/execution.service.js';
import { ExecutionContext } from '../services/pipeline/context.js';
import { StepHandlerRegistry } from '../services/pipeline/registry.js';
import type { StepType } from '../services/pipeline/types.js';
import { configuredRecipeModel } from '../config/models.js';
import { resolvePlatformApiKey } from '../services/billing/bypass.js';

const executeBodySchema = z.object({
  input: z.string().optional().default(''),
  stream: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.unknown()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const errorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()).optional(),
});

function createRegistry(opts: { byokKey?: string } = {}): StepHandlerRegistry {
  const registry = new StepHandlerRegistry();

  registry.register('llm' as StepType, {
    async execute(input: unknown, config: Record<string, unknown>) {
      const provider = String(config.provider ?? 'openai');
      const configuredKey =
        provider === 'claude'
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;

      const apiKey =
        (typeof config.apiKey === 'string' && config.apiKey) ||
        opts.byokKey ||
        resolvePlatformApiKey(configuredKey) ||
        '';

      if (!apiKey) {
        throw new Error(`No API key available for ${provider} LLM step`);
      }

      const prompt = String(config.prompt ?? '').replace(
        /\{\{input\}\}/g,
        String(input ?? ''),
      );

      const languageModel = provider === 'claude'
        ? createAnthropic({ apiKey })(String(config.model ?? 'claude-sonnet-4-6-20250501'))
        : createOpenAI({ apiKey })(String(config.model ?? configuredRecipeModel() ?? 'gpt-4o'));

      const result = await generateText({
        model: languageModel,
        messages: [{ role: 'user', content: prompt }],
        ...(provider === 'claude' ? { maxOutputTokens: Number(config.maxTokens ?? 1024) } : {}),
      });

      return result.text;
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

  app.post(
    '/recipes/:id/execute',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['executions'],
        summary: 'Execute a recipe pipeline',
        description:
          'Runs the recipe step-by-step. When `stream: true`, the response is a Server-Sent Events ' +
          'stream with `step:start`, `step:complete`, and `execution:complete` events. Otherwise ' +
          'returns a JSON snapshot of the final execution.',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: executeBodySchema,
        response: { 404: errorSchema, default: z.unknown() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParamsSchema>;

      const recipe = await recipeService.findByIdAndUser(id, request.userId);
      if (!recipe) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      const { input, stream, variables } = request.body as z.infer<typeof executeBodySchema>;
      const steps = recipe.steps as Array<{
        type: string;
        name: string;
        config: Record<string, unknown>;
      }>;

      const byokKey =
        typeof request.headers['x-provider-key'] === 'string'
          ? request.headers['x-provider-key']
          : undefined;
      const registry = createRegistry({ byokKey });

      const ctx = new ExecutionContext(recipe.id, request.userId, variables);

      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const safeSend = (event: string, data: unknown) => {
          try {
            if (!request.raw.destroyed) {
              reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
          } catch {}
        };

        request.raw.on('close', () => {
          ctx.abort();
        });

        const timeout = setTimeout(() => {
          ctx.abort();
        }, 5 * 60 * 1000);

        try {
          await runPipeline(
            ctx,
            registry,
            steps,
            input,
            (index, name) => {
              safeSend('step:start', { stepIndex: index, stepName: name });
            },
            (index, name, output) => {
              safeSend('step:complete', {
                stepIndex: index,
                stepName: name,
                output,
              });
            },
          );
        } finally {
          clearTimeout(timeout);
        }

        const snapshot = ctx.toJSON();
        safeSend('execution:complete', {
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
          metadata: snapshot.metadata as unknown as Record<string, unknown>,
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
        metadata: snapshot.metadata as unknown as Record<string, unknown>,
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
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['executions'],
        summary: 'List executions for a recipe',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        querystring: listQuerySchema,
        response: { 404: errorSchema, default: z.unknown() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParamsSchema>;

      const recipe = await recipeService.findByIdAndUser(id, request.userId);
      if (!recipe) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      const { page, limit } = request.query as z.infer<typeof listQuerySchema>;
      const list = await executionService.listByRecipe(id, request.userId, {
        page,
        limit,
      });

      return reply.code(200).send(list);
    },
  );

  app.get(
    '/executions/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['executions'],
        summary: 'Get a single execution by ID',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: { 404: errorSchema, default: z.unknown() },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParamsSchema>;

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
