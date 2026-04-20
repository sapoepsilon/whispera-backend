# Phase 4: Recipe Execution Engine -- Implementation Plan

Phase 4 wires the pipeline infrastructure from Phase 1 (PipelineExecutor, StepHandlerRegistry, ProviderRouter with Claude + OpenAI adapters) together with Phase 3's recipe CRUD and Phase 2's auth so that recipes can actually execute end-to-end.

This document covers three Linear issues:

- **WHI-12**: Execution context and state tracking
- **WHI-19**: Implement LLM step handler
- **WHI-17**: POST /recipes/:id/execute and execution history endpoints

---

## Table of Contents

1. [File Map](#1-file-map)
2. [WHI-12: Execution Context and State Tracking](#2-whi-12-execution-context-and-state-tracking)
3. [WHI-19: LLM Step Handler](#3-whi-19-llm-step-handler)
4. [WHI-17: Execution Endpoints](#4-whi-17-execution-endpoints)
5. [Wiring Diagram](#5-wiring-diagram)
6. [SSE Streaming Implementation](#6-sse-streaming-implementation)
7. [Dependencies](#7-dependencies)
8. [Acceptance Criteria](#8-acceptance-criteria)

---

## 1. File Map

### New files to create

| File | Purpose |
|------|---------|
| `src/db/schema/executions.ts` | Drizzle table definition for execution history |
| `src/services/pipeline/context.ts` | ExecutionContext class |
| `src/services/pipeline/handlers/llm.ts` | LLM step handler |
| `src/services/pipeline/handlers/llm.test.ts` | Unit tests for LLM handler |
| `src/services/pipeline/context.test.ts` | Unit tests for ExecutionContext |
| `src/routes/executions.ts` | Execution routes (POST execute, GET history, GET single) |
| `src/routes/executions.test.ts` | Integration tests for execution endpoints |
| `src/services/execution.service.ts` | Execution business logic and DB persistence |
| `src/services/execution.service.test.ts` | Unit tests for execution service |

### Files to modify

| File | Change |
|------|--------|
| `src/db/schema/index.ts` | Re-export the new executions table |
| `src/services/pipeline/registry.ts` | Register the LLM handler at startup |
| `src/routes/index.ts` | Mount the new execution routes |
| `src/app.ts` (or equivalent server entrypoint) | Ensure handler registration runs at boot |

---

## 2. WHI-12: Execution Context and State Tracking

### 2.1 Database Schema -- `src/db/schema/executions.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { recipes } from "./recipes";
import { users } from "./users";

export const executionStatusEnum = ["running", "completed", "failed", "aborted"] as const;
export type ExecutionStatus = (typeof executionStatusEnum)[number];

export const executions = pgTable("executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipeId: uuid("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: executionStatusEnum }).notNull().default("running"),
  steps: jsonb("steps").notNull().default([]),
  variables: jsonb("variables").notNull().default({}),
  metadata: jsonb("metadata").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export type Execution = typeof executions.$inferSelect;
export type NewExecution = typeof executions.$inferInsert;
```

This needs a corresponding Drizzle migration. Run `npx drizzle-kit generate` after adding the schema file.

### 2.2 Step State Type -- `src/services/pipeline/context.ts`

The step tracking shape stored inside the `steps` jsonb column:

```typescript
export interface StepState {
  stepIndex: number;
  stepName: string;
  status: "pending" | "running" | "completed" | "failed";
  input: unknown;
  output: unknown;
  startedAt: string | null;
  completedAt: string | null;
  error?: string;
}
```

### 2.3 ExecutionContext Class -- `src/services/pipeline/context.ts`

```typescript
import { randomUUID } from "node:crypto";

export interface ExecutionMetadata {
  provider?: string;
  model?: string;
  totalTokens: number;
  totalDuration: number;
}

export class ExecutionContext {
  readonly executionId: string;
  readonly recipeId: string;
  readonly userId: string;
  readonly startedAt: Date;

  private _status: ExecutionStatus;
  private _steps: StepState[];
  private _variables: Record<string, unknown>;
  private _metadata: ExecutionMetadata;
  private _error: string | null;
  private _completedAt: Date | null;
  private _abortController: AbortController;

  constructor(recipeId: string, userId: string, initialVariables?: Record<string, unknown>);
  get status(): ExecutionStatus;
  get signal(): AbortSignal;

  initSteps(stepDefinitions: Array<{ name: string }>): void;
  markStepRunning(index: number, input: unknown): void;
  setStepResult(index: number, result: { output: unknown; metadata?: Partial<ExecutionMetadata> }): void;
  setStepError(index: number, error: string): void;
  getStepOutput(index: number): unknown;
  setVariable(key: string, value: unknown): void;
  getVariable(key: string): unknown;
  complete(): void;
  fail(error: string): void;
  abort(): void;
  toJSON(): ExecutionSnapshot;
}
```

#### Constructor

- Generates a `randomUUID()` for `executionId`.
- Sets `startedAt` to `new Date()`.
- Sets `_status` to `"running"`.
- Initializes `_steps` as empty array, `_variables` from `initialVariables` or `{}`.
- Initializes `_metadata` as `{ totalTokens: 0, totalDuration: 0 }`.
- Creates an internal `AbortController` so downstream providers can respect cancellation.

#### `initSteps(stepDefinitions)`

Populates `_steps` with one `StepState` per definition, all status `"pending"`, null timestamps, null input/output.

#### `markStepRunning(index, input)`

Sets `_steps[index].status = "running"`, records `input`, sets `startedAt` to ISO string.

#### `setStepResult(index, result)`

- Sets `_steps[index].status = "completed"`, `output = result.output`, `completedAt` to ISO string.
- If `result.metadata` is provided, accumulates `totalTokens` and `totalDuration` into `_metadata`, and updates `provider`/`model` if set.

#### `setStepError(index, error)`

Sets `_steps[index].status = "failed"`, records `error`, sets `completedAt`.

#### `getStepOutput(index)`

Returns `_steps[index].output`. Throws if index is out of range.

#### `setVariable(key, value)` / `getVariable(key)`

Read/write against `_variables`.

#### `complete()`

Sets `_status = "completed"`, `_completedAt = new Date()`.

#### `fail(error)`

Sets `_status = "failed"`, `_error = error`, `_completedAt = new Date()`.

#### `abort()`

Sets `_status = "aborted"`, calls `_abortController.abort()`, sets `_completedAt = new Date()`.

#### `toJSON(): ExecutionSnapshot`

Returns an immutable snapshot:

```typescript
export interface ExecutionSnapshot {
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
```

All nested objects are deep-copied via `structuredClone` to prevent mutation of the snapshot.

---

## 3. WHI-19: LLM Step Handler

### 3.1 Step Configuration Type

```typescript
export interface LLMStepConfig {
  type: "llm";
  config: {
    prompt: string;
    model?: string;
    provider?: "claude" | "openai";
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
  };
}
```

### 3.2 Template Interpolation

The `prompt` (and `systemPrompt`) fields support Mustache-style `{{expression}}` interpolation. The handler resolves these before sending to the provider.

Supported references:

| Expression | Resolves to |
|------------|-------------|
| `{{input}}` | The output from the previous step. For the first step, this is the user-supplied `input` string from the request body (or empty string). |
| `{{variables.keyName}}` | A named variable from the execution context. |
| `{{steps[0].output}}` | Output of a specific step by index. |

Implementation: a `interpolate(template: string, context: ExecutionContext, previousOutput: unknown): string` function.

```typescript
function interpolate(
  template: string,
  ctx: ExecutionContext,
  previousOutput: unknown,
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, expression: string) => {
    const expr = expression.trim();

    if (expr === "input") {
      return String(previousOutput ?? "");
    }

    if (expr.startsWith("variables.")) {
      const key = expr.slice("variables.".length);
      return String(ctx.getVariable(key) ?? "");
    }

    const stepsMatch = expr.match(/^steps\[(\d+)\]\.output$/);
    if (stepsMatch) {
      const index = parseInt(stepsMatch[1], 10);
      return String(ctx.getStepOutput(index) ?? "");
    }

    return "";
  });
}
```

### 3.3 LLM Handler -- `src/services/pipeline/handlers/llm.ts`

```typescript
import type { StepHandler, StepResult } from "../types";
import type { ProviderRouter } from "../../providers/router";
import type { ExecutionContext } from "../context";

export class LLMStepHandler implements StepHandler {
  readonly type = "llm";
  private router: ProviderRouter;

  constructor(router: ProviderRouter);

  async execute(
    stepConfig: LLMStepConfig["config"],
    context: ExecutionContext,
    previousOutput: unknown,
  ): Promise<StepResult>;

  async *executeStream(
    stepConfig: LLMStepConfig["config"],
    context: ExecutionContext,
    previousOutput: unknown,
  ): AsyncGenerator<StreamChunk, StepResult>;
}
```

#### `execute()` -- non-streaming path

1. Interpolate `prompt` and `systemPrompt` using `interpolate()`.
2. Build the provider request: `{ messages: [{ role: "user", content: interpolatedPrompt }], systemPrompt?: interpolatedSystemPrompt, model: stepConfig.model, temperature: stepConfig.temperature, maxTokens: stepConfig.maxTokens }`.
3. Call `this.router.complete(request, { signal: context.signal })` where `complete` is the non-streaming method on ProviderRouter from Phase 1.
4. Catch provider errors and wrap them in a `StepError`:
   ```typescript
   export class StepError extends Error {
     constructor(
       message: string,
       public readonly stepIndex: number,
       public readonly stepName: string,
       public readonly cause?: Error,
     ) {
       super(message);
       this.name = "StepError";
     }
   }
   ```
5. Return `StepResult`:
   ```typescript
   {
     output: response.content,
     metadata: {
       provider: response.provider,
       model: response.model,
       tokens: response.usage.totalTokens,
       duration: elapsed,
     }
   }
   ```

#### `executeStream()` -- streaming path

1. Same interpolation and request building as above.
2. Call `this.router.stream(request, { signal: context.signal })` which returns an `AsyncIterable<StreamEvent>` from Phase 1.
3. Yield `StreamChunk` objects as they arrive:
   ```typescript
   export interface StreamChunk {
     type: "delta" | "metadata";
     delta?: string;
     metadata?: Partial<StepResult["metadata"]>;
   }
   ```
4. Accumulate the full output string internally.
5. On stream completion, return the final `StepResult` with the full accumulated output and metadata.
6. On error, throw `StepError`.

### 3.4 Handler Registration

In `src/services/pipeline/registry.ts` (or wherever StepHandlerRegistry lives from Phase 1), add during application boot:

```typescript
import { LLMStepHandler } from "./handlers/llm";

const router = new ProviderRouter(/* adapters */);
registry.register("llm", new LLMStepHandler(router));
```

---

## 4. WHI-17: Execution Endpoints

### 4.1 Route Registration -- `src/routes/executions.ts`

Three endpoints, all behind auth middleware from Phase 2:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/recipes/:id/execute` | Run a recipe |
| GET | `/recipes/:id/executions` | List execution history for a recipe (paginated) |
| GET | `/executions/:id` | Get single execution details |

### 4.2 POST /recipes/:id/execute

#### Request

```
POST /recipes/:id/execute
Authorization: Bearer <token>
Content-Type: application/json

{
  "input": "optional string, fed as {{input}} to the first step",
  "variables": { "key": "value" },
  "stream": false
}
```

All body fields are optional. `stream` defaults to `false`.

#### Route handler pseudocode

```typescript
async function executeRecipe(
  request: FastifyRequest<{
    Params: { id: string };
    Body: { input?: string; variables?: Record<string, unknown>; stream?: boolean };
  }>,
  reply: FastifyReply,
) {
  const userId = request.user.id; // from Phase 2 auth
  const recipeId = request.params.id;

  // 1. Load recipe, verify ownership
  const recipe = await recipeService.getByIdAndUserId(recipeId, userId);
  if (!recipe) {
    return reply.code(404).send({ error: "Recipe not found" });
  }

  // 2. Create ExecutionContext
  const ctx = new ExecutionContext(recipeId, userId, body.variables);
  ctx.initSteps(recipe.steps);

  // 3. Branch on streaming mode
  if (body.stream) {
    return handleStreamingExecution(reply, recipe, ctx, body.input);
  } else {
    return handleNonStreamingExecution(reply, recipe, ctx, body.input);
  }
}
```

#### Non-streaming path

```typescript
async function handleNonStreamingExecution(
  reply: FastifyReply,
  recipe: Recipe,
  ctx: ExecutionContext,
  input?: string,
) {
  try {
    const executor = new PipelineExecutor(registry);
    await executor.run(recipe.steps, ctx, input);
    ctx.complete();

    const snapshot = ctx.toJSON();
    await executionService.save(snapshot);

    const lastStep = snapshot.steps[snapshot.steps.length - 1];
    return reply.code(200).send({
      executionId: snapshot.executionId,
      status: snapshot.status,
      steps: snapshot.steps,
      output: lastStep?.output ?? null,
    });
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : String(error));
    const snapshot = ctx.toJSON();
    await executionService.save(snapshot);

    return reply.code(500).send({
      executionId: snapshot.executionId,
      status: snapshot.status,
      error: snapshot.error,
      steps: snapshot.steps,
    });
  }
}
```

#### Streaming path (see Section 6 for SSE details)

```typescript
async function handleStreamingExecution(
  reply: FastifyReply,
  recipe: Recipe,
  ctx: ExecutionContext,
  input?: string,
) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let previousOutput: unknown = input ?? "";

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      const handler = registry.get(step.type);

      ctx.markStepRunning(i, previousOutput);
      send("step:start", { stepIndex: i, stepName: step.name });

      if (handler.executeStream) {
        const generator = handler.executeStream(step.config, ctx, previousOutput);
        let result: StepResult;

        for await (const chunk of generator) {
          if (chunk.type === "delta") {
            send("step:chunk", { stepIndex: i, delta: chunk.delta });
          }
          // The generator's return value is the final StepResult
        }
        // The last value returned by the generator is the StepResult
        result = generator.return(undefined as any).value;
      } else {
        result = await handler.execute(step.config, ctx, previousOutput);
      }

      ctx.setStepResult(i, result);
      send("step:complete", { stepIndex: i, output: result.output });
      previousOutput = result.output;
    }

    ctx.complete();
    const snapshot = ctx.toJSON();
    await executionService.save(snapshot);

    send("execution:complete", {
      executionId: snapshot.executionId,
      output: previousOutput,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stepIndex = error instanceof StepError ? error.stepIndex : undefined;

    if (stepIndex !== undefined) {
      ctx.setStepError(stepIndex, message);
      send("step:error", { stepIndex, error: message });
    }

    ctx.fail(message);
    const snapshot = ctx.toJSON();
    await executionService.save(snapshot);

    send("execution:error", { error: message });
  } finally {
    reply.raw.end();
  }
}
```

**Important note on async generators**: The streaming loop above is simplified. In practice, the `AsyncGenerator` returned by `executeStream` should use `return` to deliver the final `StepResult`. The consumer pattern is:

```typescript
const gen = handler.executeStream(step.config, ctx, previousOutput);
let finalResult: StepResult | undefined;

while (true) {
  const { value, done } = await gen.next();
  if (done) {
    finalResult = value as StepResult;
    break;
  }
  if (value.type === "delta") {
    send("step:chunk", { stepIndex: i, delta: value.delta });
  }
}
```

### 4.3 GET /recipes/:id/executions

#### Request

```
GET /recipes/:id/executions?page=1&limit=20
Authorization: Bearer <token>
```

#### Handler

```typescript
async function listExecutions(
  request: FastifyRequest<{
    Params: { id: string };
    Querystring: { page?: number; limit?: number };
  }>,
  reply: FastifyReply,
) {
  const userId = request.user.id;
  const recipeId = request.params.id;

  // Verify recipe exists and belongs to user
  const recipe = await recipeService.getByIdAndUserId(recipeId, userId);
  if (!recipe) {
    return reply.code(404).send({ error: "Recipe not found" });
  }

  const page = request.query.page ?? 1;
  const limit = Math.min(request.query.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const { data, total } = await executionService.listByRecipe(recipeId, userId, {
    limit,
    offset,
  });

  return reply.code(200).send({
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}
```

#### Response

```json
{
  "data": [
    {
      "id": "uuid",
      "recipeId": "uuid",
      "status": "completed",
      "startedAt": "2026-04-19T10:00:00Z",
      "completedAt": "2026-04-19T10:00:05Z",
      "metadata": { "totalTokens": 1523, "totalDuration": 4200 },
      "error": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

The list endpoint returns summaries (no steps or variables) to keep payloads small. Full details come from the single execution endpoint.

### 4.4 GET /executions/:id

#### Request

```
GET /executions/:id
Authorization: Bearer <token>
```

#### Handler

```typescript
async function getExecution(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const userId = request.user.id;
  const executionId = request.params.id;

  const execution = await executionService.getByIdAndUserId(executionId, userId);
  if (!execution) {
    return reply.code(404).send({ error: "Execution not found" });
  }

  return reply.code(200).send({ data: execution });
}
```

Returns the full execution record including `steps`, `variables`, and `metadata`.

### 4.5 Execution Service -- `src/services/execution.service.ts`

```typescript
import { db } from "../db";
import { executions } from "../db/schema/executions";
import { eq, and, desc, sql } from "drizzle-orm";

export class ExecutionService {
  async save(snapshot: ExecutionSnapshot): Promise<void>;
  async getByIdAndUserId(executionId: string, userId: string): Promise<Execution | null>;
  async listByRecipe(
    recipeId: string,
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<{ data: Execution[]; total: number }>;
}
```

#### `save(snapshot)`

Upserts an execution record. Uses `INSERT ... ON CONFLICT (id) DO UPDATE` so the same execution can be saved when it transitions from running to completed/failed.

```typescript
async save(snapshot: ExecutionSnapshot): Promise<void> {
  await db
    .insert(executions)
    .values({
      id: snapshot.executionId,
      recipeId: snapshot.recipeId,
      userId: snapshot.userId,
      status: snapshot.status,
      steps: snapshot.steps,
      variables: snapshot.variables,
      metadata: snapshot.metadata,
      startedAt: new Date(snapshot.startedAt),
      completedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : null,
      error: snapshot.error,
    })
    .onConflictDoUpdate({
      target: executions.id,
      set: {
        status: sql`excluded.status`,
        steps: sql`excluded.steps`,
        variables: sql`excluded.variables`,
        metadata: sql`excluded.metadata`,
        completedAt: sql`excluded.completed_at`,
        error: sql`excluded.error`,
      },
    });
}
```

#### `listByRecipe(recipeId, userId, options)`

```typescript
async listByRecipe(
  recipeId: string,
  userId: string,
  options: { limit: number; offset: number },
): Promise<{ data: Execution[]; total: number }> {
  const condition = and(
    eq(executions.recipeId, recipeId),
    eq(executions.userId, userId),
  );

  const [data, countResult] = await Promise.all([
    db
      .select({
        id: executions.id,
        recipeId: executions.recipeId,
        status: executions.status,
        startedAt: executions.startedAt,
        completedAt: executions.completedAt,
        metadata: executions.metadata,
        error: executions.error,
      })
      .from(executions)
      .where(condition)
      .orderBy(desc(executions.startedAt))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(executions)
      .where(condition),
  ]);

  return { data, total: countResult[0].count };
}
```

#### `getByIdAndUserId(executionId, userId)`

```typescript
async getByIdAndUserId(executionId: string, userId: string): Promise<Execution | null> {
  const result = await db
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.userId, userId),
      ),
    )
    .limit(1);

  return result[0] ?? null;
}
```

---

## 5. Wiring Diagram

This section explains how the four core components connect at runtime.

### Boot sequence (in `src/app.ts` or a dedicated `src/bootstrap.ts`)

```
1. Create ProviderRouter
   - Register ClaudeAdapter with API key from env
   - Register OpenAIAdapter with API key from env

2. Create StepHandlerRegistry
   - Register LLMStepHandler(router) under type "llm"
   - (Future: register "transform", "conditional", "http" handlers)

3. Create PipelineExecutor(registry)
   - Receives the registry so it can look up handlers by step type

4. Create ExecutionService
   - Has direct access to the db instance

5. Register Fastify routes
   - Inject PipelineExecutor, ExecutionService, and RecipeService into route handlers
```

### Runtime flow for POST /recipes/:id/execute

```
Request arrives
  |
  v
Auth middleware (Phase 2) -- extracts user from JWT
  |
  v
Route handler
  |-- Load recipe via RecipeService (Phase 3)
  |-- Create ExecutionContext(recipeId, userId, variables)
  |-- ctx.initSteps(recipe.steps)
  |
  |-- [Non-streaming path]
  |     |
  |     v
  |   PipelineExecutor.run(recipe.steps, ctx, input)
  |     |
  |     |-- For each step:
  |     |     |-- handler = registry.get(step.type)      // StepHandlerRegistry
  |     |     |-- ctx.markStepRunning(i, previousOutput)
  |     |     |-- result = handler.execute(config, ctx, previousOutput)
  |     |     |     |
  |     |     |     |-- [LLMStepHandler]
  |     |     |     |     |-- interpolate(prompt, ctx, previousOutput)
  |     |     |     |     |-- router.complete(request)    // ProviderRouter
  |     |     |     |     |     |-- Selects adapter (Claude or OpenAI)
  |     |     |     |     |     |-- Adapter calls external API
  |     |     |     |     |     |-- Returns response
  |     |     |     |     |-- Return StepResult
  |     |     |     |
  |     |     |-- ctx.setStepResult(i, result)
  |     |     |-- previousOutput = result.output
  |     |
  |     |-- ctx.complete()
  |     |-- executionService.save(ctx.toJSON())
  |     |-- Return JSON response
  |
  |-- [Streaming path]
        |
        v
      Set SSE headers on reply.raw
        |
        |-- For each step:
        |     |-- handler = registry.get(step.type)
        |     |-- ctx.markStepRunning(i, previousOutput)
        |     |-- send SSE: step:start
        |     |-- generator = handler.executeStream(config, ctx, previousOutput)
        |     |-- For each chunk from generator:
        |     |     |-- send SSE: step:chunk { delta }
        |     |-- On generator return:
        |     |     |-- ctx.setStepResult(i, result)
        |     |     |-- send SSE: step:complete { output }
        |     |     |-- previousOutput = result.output
        |
        |-- ctx.complete()
        |-- executionService.save(ctx.toJSON())
        |-- send SSE: execution:complete
        |-- reply.raw.end()
```

### Dependency injection approach

Use Fastify's `decorate` to make services available on the Fastify instance:

```typescript
// In src/app.ts or plugin registration
fastify.decorate("pipelineExecutor", executor);
fastify.decorate("executionService", executionService);
fastify.decorate("recipeService", recipeService);
```

Route handlers access them via `request.server.pipelineExecutor`, etc. Add corresponding TypeScript declarations:

```typescript
declare module "fastify" {
  interface FastifyInstance {
    pipelineExecutor: PipelineExecutor;
    executionService: ExecutionService;
    recipeService: RecipeService;
  }
}
```

---

## 6. SSE Streaming Implementation

### 6.1 Fastify SSE Setup

Fastify does not natively support SSE, but it is straightforward using `reply.raw` (the underlying Node.js `http.ServerResponse`).

Key considerations:

- Disable Fastify's automatic response serialization by working with `reply.raw` directly.
- Call `reply.hijack()` to tell Fastify not to manage the response lifecycle.
- Set `Content-Type: text/event-stream`.
- Disable any compression middleware for this route (gzip breaks SSE).

```typescript
reply.hijack();
reply.raw.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no", // prevents nginx from buffering
});
```

### 6.2 SSE Event Format

Each event follows the SSE spec:

```
event: <event-name>\ndata: <json-string>\n\n
```

Helper function:

```typescript
function sendSSE(raw: http.ServerResponse, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

### 6.3 Event Types

| Event | Payload | When |
|-------|---------|------|
| `step:start` | `{ stepIndex: number, stepName: string }` | Step begins execution |
| `step:chunk` | `{ stepIndex: number, delta: string }` | LLM produces a text chunk |
| `step:complete` | `{ stepIndex: number, output: unknown }` | Step finishes successfully |
| `step:error` | `{ stepIndex: number, error: string }` | Step fails |
| `execution:complete` | `{ executionId: string, output: unknown }` | All steps finished |
| `execution:error` | `{ error: string }` | Execution-level failure |

### 6.4 Client Disconnection Handling

Listen for the `close` event on the request to detect client disconnection and abort the execution:

```typescript
request.raw.on("close", () => {
  if (ctx.status === "running") {
    ctx.abort();
  }
});
```

Because `ctx.abort()` triggers the internal `AbortController`, any in-flight provider API call that respects the signal will terminate early.

### 6.5 Heartbeat

To prevent proxies and load balancers from closing idle connections during long-running LLM calls, send a comment-based heartbeat every 15 seconds:

```typescript
const heartbeat = setInterval(() => {
  if (!reply.raw.destroyed) {
    reply.raw.write(": heartbeat\n\n");
  }
}, 15_000);

// Clean up in the finally block
clearInterval(heartbeat);
```

---

## 7. Dependencies

### npm packages (already expected from Phase 1-3)

| Package | Used for |
|---------|----------|
| `fastify` | HTTP framework |
| `drizzle-orm` | Database ORM |
| `drizzle-kit` | Migration generation |
| `pg` / `postgres` | PostgreSQL driver |
| `uuid` or Node.js `crypto.randomUUID` | Execution ID generation |
| `zod` | Request validation |

### No new npm packages required

Phase 4 does not introduce any new external dependencies. SSE is implemented using Node.js built-in `http.ServerResponse`. Template interpolation is a simple regex replace. The `AbortController` is a Node.js global.

### Internal dependencies (from earlier phases)

| Module | Phase | Used by |
|--------|-------|---------|
| `PipelineExecutor` | Phase 1 | Route handler (orchestrates step execution) |
| `StepHandlerRegistry` | Phase 1 | Boot sequence (register handlers), PipelineExecutor (look up handlers) |
| `StepHandler` interface | Phase 1 | LLMStepHandler (implements it) |
| `StepResult` type | Phase 1 | LLMStepHandler (returns it) |
| `ProviderRouter` | Phase 1 | LLMStepHandler (routes to Claude/OpenAI) |
| `ClaudeAdapter`, `OpenAIAdapter` | Phase 1 | ProviderRouter (registered at boot) |
| Auth middleware | Phase 2 | Route registration (protects all endpoints) |
| `RecipeService` | Phase 3 | Route handler (loads recipe by ID) |
| `recipes` schema | Phase 3 | Foreign key in executions table |
| `users` schema | Phase 2 | Foreign key in executions table |

---

## 8. Acceptance Criteria

### WHI-12: Execution Context and State Tracking

- [ ] `executions` table exists in the database with columns: id, recipeId, userId, status, steps (jsonb), variables (jsonb), metadata (jsonb), startedAt, completedAt, error.
- [ ] Drizzle migration is generated and applies cleanly.
- [ ] `ExecutionContext` class can be instantiated with `recipeId` and `userId`.
- [ ] `initSteps()` creates the correct number of step state entries, all with status `"pending"`.
- [ ] `markStepRunning()` transitions a step to `"running"` and records its input and start time.
- [ ] `setStepResult()` transitions a step to `"completed"`, records output, and accumulates token/duration metadata.
- [ ] `setStepError()` transitions a step to `"failed"` and records the error message.
- [ ] `getStepOutput()` returns the output for a completed step and throws for out-of-range indices.
- [ ] `setVariable()` and `getVariable()` correctly read and write shared variables.
- [ ] `complete()` sets status to `"completed"` and records completedAt.
- [ ] `fail(error)` sets status to `"failed"`, records the error, and records completedAt.
- [ ] `abort()` sets status to `"aborted"`, triggers the AbortController signal, and records completedAt.
- [ ] `toJSON()` returns an immutable deep copy -- mutating the returned object does not affect the context.
- [ ] Unit tests cover all of the above.

### WHI-19: LLM Step Handler

- [ ] `LLMStepHandler` implements the `StepHandler` interface from Phase 1.
- [ ] Template interpolation correctly resolves `{{input}}`, `{{variables.keyName}}`, and `{{steps[N].output}}`.
- [ ] Unrecognized template expressions resolve to empty string (no crash).
- [ ] `execute()` calls ProviderRouter.complete() with interpolated prompt and returns a StepResult.
- [ ] `execute()` respects `provider`, `model`, `temperature`, and `maxTokens` from step config.
- [ ] `execute()` passes `context.signal` to the provider for abort support.
- [ ] `executeStream()` yields StreamChunk objects with `type: "delta"` and the text fragment.
- [ ] `executeStream()` returns the final StepResult with accumulated output and metadata.
- [ ] Provider errors are wrapped in `StepError` with stepIndex, stepName, and the original error as cause.
- [ ] Handler is registered in StepHandlerRegistry under type `"llm"` at application boot.
- [ ] Unit tests mock ProviderRouter and verify interpolation, non-streaming, and streaming paths.

### WHI-17: Execution Endpoints

- [ ] `POST /recipes/:id/execute` requires authentication (returns 401 without valid token).
- [ ] Returns 404 if the recipe does not exist or does not belong to the authenticated user.
- [ ] Non-streaming mode: returns JSON with `executionId`, `status`, `steps`, and `output` (the last step's output).
- [ ] Non-streaming mode: execution is saved to the database after completion.
- [ ] Non-streaming mode: on step failure, execution is saved with status `"failed"` and the error is returned.
- [ ] Streaming mode (`stream: true`): response has `Content-Type: text/event-stream`.
- [ ] Streaming mode: emits `step:start` at the beginning of each step.
- [ ] Streaming mode: emits `step:chunk` for each LLM text delta during streaming steps.
- [ ] Streaming mode: emits `step:complete` when a step finishes with its output.
- [ ] Streaming mode: emits `step:error` if a step fails.
- [ ] Streaming mode: emits `execution:complete` with the final output after all steps succeed.
- [ ] Streaming mode: emits `execution:error` if the execution fails.
- [ ] Streaming mode: execution is saved to the database after completion or failure.
- [ ] Streaming mode: client disconnect triggers `ctx.abort()`.
- [ ] `GET /recipes/:id/executions` requires authentication.
- [ ] Returns paginated list of executions for the recipe (defaults to page 1, limit 20, max limit 100).
- [ ] List response includes summary fields only (no steps/variables) and pagination metadata.
- [ ] Returns 404 if the recipe does not exist or does not belong to the user.
- [ ] `GET /executions/:id` requires authentication.
- [ ] Returns the full execution record including steps, variables, and metadata.
- [ ] Returns 404 if the execution does not exist or does not belong to the user.
- [ ] Integration tests cover the happy path and error cases for all three endpoints.

### Cross-cutting

- [ ] No new npm dependencies are introduced.
- [ ] All new files have corresponding test files.
- [ ] Existing Phase 1 types (`StepHandler`, `StepResult`) are used without modification, or modifications are backward-compatible.
- [ ] PipelineExecutor from Phase 1 is extended (if needed) to accept ExecutionContext and delegate to handlers, without breaking its existing interface.
