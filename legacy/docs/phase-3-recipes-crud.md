# Phase 3: Recipes CRUD -- Implementation Plan

Phase 3 builds on the auth infrastructure from Phase 2 (JWT tokens, `authenticate` preHandler) and the scaffold/DB/pipeline from Phase 1 (Fastify, Drizzle, PostgreSQL). It introduces the core `recipes` domain: schema, validation, service layer, and five HTTP endpoints.

Linear issues covered: WHI-14, WHI-15, WHI-18, WHI-16, WHI-11.

---

## Table of Contents

1. [Files to Create or Modify](#1-files-to-create-or-modify)
2. [WHI-14: Recipe DB Schema](#2-whi-14-recipe-db-schema)
3. [WHI-15: POST /recipes](#3-whi-15-post-recipes)
4. [WHI-18: GET /recipes](#4-whi-18-get-recipes)
5. [WHI-16: PUT /recipes/:id](#5-whi-16-put-recipesid)
6. [WHI-11: DELETE /recipes/:id](#6-whi-11-delete-recipesid)
7. [Zod Validation Schemas](#7-zod-validation-schemas)
8. [RecipeService Class](#8-recipeservice-class)
9. [Key Interfaces and Types](#9-key-interfaces-and-types)
10. [Dependencies](#10-dependencies)
11. [Acceptance Criteria](#11-acceptance-criteria)

---

## 1. Files to Create or Modify

### New files

| File | Purpose |
|------|---------|
| `src/db/schema/recipes.ts` | Drizzle table definition, indexes, TypeScript types |
| `src/routes/recipes/index.ts` | Fastify route plugin registering all CRUD endpoints |
| `src/routes/recipes/schemas.ts` | Zod request/response schemas and derived TypeScript types |
| `src/services/recipes/index.ts` | `RecipeService` class encapsulating all DB operations |

### Modified files

| File | Change |
|------|--------|
| `src/db/schema/index.ts` | Re-export `recipes` table and types from `./recipes` |
| `src/routes/index.ts` (or `src/app.ts`) | Register the recipes route plugin under prefix `/recipes` |
| `drizzle.config.ts` | No change needed if it already points to `src/db/schema/index.ts` |

### Generated files (via `drizzle-kit generate`)

| File | Purpose |
|------|---------|
| `drizzle/<timestamp>_create_recipes.sql` | Migration SQL for the `recipes` table and indexes |

---

## 2. WHI-14: Recipe DB Schema

### File: `src/db/schema/recipes.ts`

```typescript
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 255 }).notNull(),

    description: text("description"),

    triggerPhrase: varchar("trigger_phrase", { length: 255 }),

    steps: jsonb("steps").$type<RecipeStep[]>().notNull(),

    integrations: jsonb("integrations").$type<RecipeIntegration[]>(),

    permissions: jsonb("permissions").$type<RecipePermissions>(),

    outputFormat: varchar("output_format", { length: 50 })
      .default("text")
      .notNull(),

    isPublic: boolean("is_public").default(false).notNull(),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("recipes_user_id_idx").on(table.userId),
    index("recipes_trigger_phrase_idx").on(table.triggerPhrase),
    index("recipes_is_public_idx").on(table.isPublic),
  ]
);
```

### JSONB type definitions (same file, above the table)

```typescript
export const STEP_TYPES = [
  "llm",
  "tool",
  "http",
  "shell",
  "sandbox",
  "approval",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

export interface RecipeStep {
  type: StepType;
  config: Record<string, unknown>;
  name?: string;
}

export interface RecipeIntegration {
  provider: string;
  required: boolean;
  scopes?: string[];
}

export interface RecipePermissions {
  allowedTools?: string[];
  allowedUrls?: string[];
  sandboxOnly?: boolean;
}
```

### Inferred Drizzle types (same file, bottom)

```typescript
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

export type Recipe = InferSelectModel<typeof recipes>;
export type NewRecipe = InferInsertModel<typeof recipes>;
```

### Re-export from schema barrel

In `src/db/schema/index.ts`, add:

```typescript
export * from "./recipes";
```

### Migration

Run `npx drizzle-kit generate` to produce the migration file, then `npx drizzle-kit migrate` to apply.

The generated SQL will be equivalent to:

```sql
CREATE TABLE IF NOT EXISTS "recipes" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name"           varchar(255) NOT NULL,
  "description"    text,
  "trigger_phrase"  varchar(255),
  "steps"          jsonb NOT NULL,
  "integrations"   jsonb,
  "permissions"    jsonb,
  "output_format"  varchar(50) NOT NULL DEFAULT 'text',
  "is_public"      boolean NOT NULL DEFAULT false,
  "deleted_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "recipes_user_id_idx" ON "recipes" ("user_id");
CREATE INDEX "recipes_trigger_phrase_idx" ON "recipes" ("trigger_phrase");
CREATE INDEX "recipes_is_public_idx" ON "recipes" ("is_public");
```

---

## 3. WHI-15: POST /recipes

### Route

`POST /recipes`

### Auth

`authenticate` preHandler (from Phase 2). The request must include a valid JWT. The authenticated user's ID is read from `request.user.id`.

### Request body

```json
{
  "name": "Summarize article",
  "description": "Fetches a URL and produces a summary",
  "triggerPhrase": "summarize this",
  "steps": [
    { "type": "http", "config": { "url": "{{input}}" }, "name": "Fetch page" },
    { "type": "llm", "config": { "prompt": "Summarize: {{prev.body}}" }, "name": "Summarize" }
  ],
  "integrations": [{ "provider": "openai", "required": true }],
  "permissions": { "allowedUrls": ["*"], "sandboxOnly": false },
  "outputFormat": "markdown"
}
```

### Validation rules

- `name`: required, string, 1-255 chars, trimmed
- `description`: optional, string, max 2000 chars
- `triggerPhrase`: optional, string, 1-255 chars
- `steps`: required, array, min length 1, max length 50; each element must have `type` in `STEP_TYPES` and `config` as a non-null object; `name` is optional string
- `integrations`: optional, array of `{ provider: string, required: boolean, scopes?: string[] }`
- `permissions`: optional, object `{ allowedTools?: string[], allowedUrls?: string[], sandboxOnly?: boolean }`
- `outputFormat`: optional, one of `"text" | "markdown" | "json" | "clipboard"`, defaults to `"text"`

### Handler logic

1. Parse and validate body against `createRecipeBodySchema` (Zod).
2. Call `RecipeService.create(request.user.id, body)`.
3. Return the full recipe object with HTTP 201.

### Response (201)

```json
{
  "id": "uuid",
  "userId": "uuid",
  "name": "...",
  "description": "...",
  "triggerPhrase": "...",
  "steps": [...],
  "integrations": [...],
  "permissions": {...},
  "outputFormat": "markdown",
  "isPublic": false,
  "createdAt": "ISO string",
  "updatedAt": "ISO string"
}
```

### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Validation failure (invalid body, empty steps, bad step type) |
| 401 | Missing or invalid JWT |

---

## 4. WHI-18: GET /recipes

### Route

`GET /recipes`

### Auth

`authenticate` preHandler.

### Query parameters

| Param | Type | Default | Constraints |
|-------|------|---------|-------------|
| `search` | string | -- | Optional. Filters by `name ILIKE '%search%'`. |
| `tag` | string | -- | Reserved for future use. Ignored for now. |
| `page` | integer | 1 | Min 1. |
| `limit` | integer | 20 | Min 1, max 100. |

### Handler logic

1. Parse and validate query params against `listRecipesQuerySchema`.
2. Call `RecipeService.listByUser(request.user.id, { search, page, limit })`.
3. The service applies filters: `userId = request.user.id AND deletedAt IS NULL`, plus optional ILIKE on `name`.
4. The service runs two queries in parallel: one for the paginated rows, one for the total count.
5. Return paginated response.

### Response (200)

```json
{
  "data": [ /* Recipe objects, same shape as POST response */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42
  }
}
```

### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Invalid query params (page < 1, limit > 100, etc.) |
| 401 | Missing or invalid JWT |

---

## 5. WHI-16: PUT /recipes/:id

### Route

`PUT /recipes/:id`

### Auth

`authenticate` preHandler.

### URL params

- `id`: uuid, validated by Zod

### Request body (partial update)

Any subset of: `{ name?, description?, triggerPhrase?, steps?, integrations?, permissions?, outputFormat?, isPublic? }`

At least one field must be present.

### Validation rules

Same per-field rules as POST, but every field is optional. The body object itself must have at least one key.

### Handler logic

1. Validate `id` param as UUID.
2. Parse and validate body against `updateRecipeBodySchema`.
3. Call `RecipeService.update(request.user.id, id, body)`.
4. Inside the service:
   - Find recipe where `id = :id AND userId = request.user.id AND deletedAt IS NULL`.
   - If not found, throw a 404 error.
   - Apply partial update + set `updatedAt = now()`.
   - Return updated recipe.
5. Return updated recipe with HTTP 200.

### Response (200)

Full updated recipe object.

### Error responses

| Status | Condition |
|--------|-----------|
| 400 | Validation failure |
| 401 | Missing or invalid JWT |
| 404 | Recipe not found or not owned by user |

---

## 6. WHI-11: DELETE /recipes/:id

### Route

`DELETE /recipes/:id`

### Auth

`authenticate` preHandler.

### URL params

- `id`: uuid, validated by Zod

### Handler logic

1. Validate `id` param as UUID.
2. Call `RecipeService.softDelete(request.user.id, id)`.
3. Inside the service:
   - Find recipe where `id = :id AND userId = request.user.id AND deletedAt IS NULL`.
   - If not found, throw a 404 error.
   - Set `deletedAt = now()`.
4. Return HTTP 204 (no body).

### Error responses

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid JWT |
| 404 | Recipe not found or not owned by user |

---

## 7. Zod Validation Schemas

### File: `src/routes/recipes/schemas.ts`

```typescript
import { z } from "zod";
import { STEP_TYPES } from "../../db/schema/recipes";

// -- Shared sub-schemas --

const stepSchema = z.object({
  type: z.enum(STEP_TYPES),
  config: z.record(z.unknown()),
  name: z.string().max(255).optional(),
});

const integrationSchema = z.object({
  provider: z.string().min(1),
  required: z.boolean(),
  scopes: z.array(z.string()).optional(),
});

const permissionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allowedUrls: z.array(z.string()).optional(),
  sandboxOnly: z.boolean().optional(),
});

const outputFormatEnum = z.enum(["text", "markdown", "json", "clipboard"]);

// -- POST /recipes --

export const createRecipeBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  triggerPhrase: z.string().min(1).max(255).optional(),
  steps: z.array(stepSchema).min(1).max(50),
  integrations: z.array(integrationSchema).optional(),
  permissions: permissionsSchema.optional(),
  outputFormat: outputFormatEnum.default("text"),
});

export type CreateRecipeBody = z.infer<typeof createRecipeBodySchema>;

// -- GET /recipes --

export const listRecipesQuerySchema = z.object({
  search: z.string().max(255).optional(),
  tag: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListRecipesQuery = z.infer<typeof listRecipesQuerySchema>;

// -- PUT /recipes/:id --

export const updateRecipeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    triggerPhrase: z.string().min(1).max(255).nullable().optional(),
    steps: z.array(stepSchema).min(1).max(50).optional(),
    integrations: z.array(integrationSchema).nullable().optional(),
    permissions: permissionsSchema.nullable().optional(),
    outputFormat: outputFormatEnum.optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateRecipeBody = z.infer<typeof updateRecipeBodySchema>;

// -- Shared param schema --

export const recipeIdParamSchema = z.object({
  id: z.string().uuid(),
});

// -- Response schemas --

export const recipeResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  triggerPhrase: z.string().nullable(),
  steps: z.array(stepSchema),
  integrations: z.array(integrationSchema).nullable(),
  permissions: permissionsSchema.nullable(),
  outputFormat: z.string(),
  isPublic: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const paginatedRecipesResponseSchema = z.object({
  data: z.array(recipeResponseSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
  }),
});
```

### Design notes

- `description`, `triggerPhrase`, `integrations`, and `permissions` accept `nullable()` in the update schema so a client can explicitly clear a field by sending `null`.
- `z.coerce.number()` is used for query params because Fastify delivers query strings as `string` values.
- The `.refine()` on `updateRecipeBodySchema` rejects empty update bodies.

---

## 8. RecipeService Class

### File: `src/services/recipes/index.ts`

```typescript
import { eq, and, isNull, ilike, sql, count } from "drizzle-orm";
import { db } from "../../db";
import { recipes } from "../../db/schema";
import type { Recipe } from "../../db/schema";
import type {
  CreateRecipeBody,
  UpdateRecipeBody,
  ListRecipesQuery,
} from "../../routes/recipes/schemas";

export class RecipeService {
  /**
   * Insert a new recipe for the given user.
   */
  async create(userId: string, body: CreateRecipeBody): Promise<Recipe> {
    const [recipe] = await db
      .insert(recipes)
      .values({
        userId,
        name: body.name,
        description: body.description ?? null,
        triggerPhrase: body.triggerPhrase ?? null,
        steps: body.steps,
        integrations: body.integrations ?? null,
        permissions: body.permissions ?? null,
        outputFormat: body.outputFormat,
      })
      .returning();

    return recipe;
  }

  /**
   * Paginated list of non-deleted recipes belonging to the user.
   */
  async listByUser(
    userId: string,
    query: ListRecipesQuery
  ): Promise<{ data: Recipe[]; pagination: { page: number; limit: number; total: number } }> {
    const { search, page, limit } = query;
    const offset = (page - 1) * limit;

    const baseConditions = and(
      eq(recipes.userId, userId),
      isNull(recipes.deletedAt)
    );

    const conditions = search
      ? and(baseConditions, ilike(recipes.name, `%${search}%`))
      : baseConditions;

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(recipes)
        .where(conditions)
        .orderBy(recipes.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(recipes)
        .where(conditions),
    ]);

    return {
      data,
      pagination: { page, limit, total },
    };
  }

  /**
   * Partial update. Returns the updated recipe or null if not found/not owned.
   */
  async update(
    userId: string,
    recipeId: string,
    body: UpdateRecipeBody
  ): Promise<Recipe | null> {
    const [updated] = await db
      .update(recipes)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recipes.id, recipeId),
          eq(recipes.userId, userId),
          isNull(recipes.deletedAt)
        )
      )
      .returning();

    return updated ?? null;
  }

  /**
   * Soft-delete by setting deletedAt. Returns true if a row was affected.
   */
  async softDelete(userId: string, recipeId: string): Promise<boolean> {
    const result = await db
      .update(recipes)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(recipes.id, recipeId),
          eq(recipes.userId, userId),
          isNull(recipes.deletedAt)
        )
      )
      .returning({ id: recipes.id });

    return result.length > 0;
  }

  /**
   * Fetch a single recipe by ID for the owning user.
   */
  async findByIdAndUser(
    userId: string,
    recipeId: string
  ): Promise<Recipe | null> {
    const [recipe] = await db
      .select()
      .from(recipes)
      .where(
        and(
          eq(recipes.id, recipeId),
          eq(recipes.userId, userId),
          isNull(recipes.deletedAt)
        )
      );

    return recipe ?? null;
  }
}
```

### Design notes

- The `update` method uses a single `UPDATE ... WHERE ... RETURNING` query rather than a separate SELECT then UPDATE. This avoids race conditions and keeps the operation atomic. If zero rows are returned, the recipe either does not exist, is not owned by the requesting user, or has been soft-deleted -- all of which surface as a 404 from the route handler.
- The `softDelete` method follows the same pattern: one query, check `result.length`.
- `listByUser` runs the data query and count query in parallel with `Promise.all`.

---

## 9. Route Handler Registration

### File: `src/routes/recipes/index.ts`

```typescript
import type { FastifyPluginAsync } from "fastify";
import { RecipeService } from "../../services/recipes";
import {
  createRecipeBodySchema,
  listRecipesQuerySchema,
  updateRecipeBodySchema,
  recipeIdParamSchema,
} from "./schemas";

const recipeService = new RecipeService();

const recipesRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes in this plugin require authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // POST /recipes
  fastify.post("/", async (request, reply) => {
    const body = createRecipeBodySchema.parse(request.body);
    const recipe = await recipeService.create(request.user.id, body);
    return reply.status(201).send(recipe);
  });

  // GET /recipes
  fastify.get("/", async (request, reply) => {
    const query = listRecipesQuerySchema.parse(request.query);
    const result = await recipeService.listByUser(request.user.id, query);
    return reply.send(result);
  });

  // PUT /recipes/:id
  fastify.put("/:id", async (request, reply) => {
    const { id } = recipeIdParamSchema.parse(request.params);
    const body = updateRecipeBodySchema.parse(request.body);
    const recipe = await recipeService.update(request.user.id, id, body);

    if (!recipe) {
      return reply.status(404).send({ message: "Recipe not found" });
    }

    return reply.send(recipe);
  });

  // DELETE /recipes/:id
  fastify.delete("/:id", async (request, reply) => {
    const { id } = recipeIdParamSchema.parse(request.params);
    const deleted = await recipeService.softDelete(request.user.id, id);

    if (!deleted) {
      return reply.status(404).send({ message: "Recipe not found" });
    }

    return reply.status(204).send();
  });
};

export default recipesRoutes;
```

### Plugin registration (in app setup)

In `src/routes/index.ts` or `src/app.ts`:

```typescript
import recipesRoutes from "./routes/recipes";

fastify.register(recipesRoutes, { prefix: "/recipes" });
```

### Error handling

Zod validation errors should be caught by a global error handler (assumed to exist from Phase 1 or Phase 2). The handler should detect `ZodError` instances and return a 400 response with structured error details:

```typescript
// In global error handler (already exists or must be added)
import { ZodError } from "zod";

fastify.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      message: "Validation error",
      errors: error.flatten().fieldErrors,
    });
  }

  // ... other error handling
});
```

If this handler does not yet exist from Phase 1/2, it must be added as part of Phase 3.

---

## 9. Key Interfaces and Types

### RecipeStep

```typescript
interface RecipeStep {
  type: "llm" | "tool" | "http" | "shell" | "sandbox" | "approval";
  config: Record<string, unknown>;
  name?: string;
}
```

Each step type represents a different execution unit in the recipe pipeline:

| type | config keys (expected, not enforced at DB level) |
|------|--------------------------------------------------|
| `llm` | `prompt`, `model?`, `temperature?`, `maxTokens?` |
| `tool` | `toolName`, `args?` |
| `http` | `url`, `method?`, `headers?`, `body?` |
| `shell` | `command`, `timeout?` |
| `sandbox` | `runtime`, `code`, `timeout?` |
| `approval` | `message?`, `approvers?` |

Step config validation beyond `Record<string, unknown>` is deferred to recipe execution time (Phase 4+). Phase 3 only validates the structural shape.

### RecipeIntegration

```typescript
interface RecipeIntegration {
  provider: string;     // e.g. "openai", "github", "slack"
  required: boolean;    // whether the recipe fails without this integration
  scopes?: string[];    // e.g. ["repo:read", "issues:write"]
}
```

### RecipePermissions

```typescript
interface RecipePermissions {
  allowedTools?: string[];   // tool names the recipe may invoke
  allowedUrls?: string[];    // URL patterns for HTTP steps
  sandboxOnly?: boolean;     // if true, shell steps run sandboxed
}
```

### Recipe (Drizzle select model)

```typescript
interface Recipe {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  triggerPhrase: string | null;
  steps: RecipeStep[];
  integrations: RecipeIntegration[] | null;
  permissions: RecipePermissions | null;
  outputFormat: string;
  isPublic: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### PaginatedResponse

```typescript
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}
```

### Fastify request.user (from Phase 2)

```typescript
interface JwtUser {
  id: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: JwtUser;
  }
}
```

---

## 10. Dependencies

### Already installed (Phase 1/2)

- `fastify` -- HTTP server
- `drizzle-orm` -- ORM / query builder
- `drizzle-kit` -- migration CLI
- `@fastify/jwt` or equivalent -- JWT auth
- `zod` -- schema validation
- `pg` or `postgres` -- PostgreSQL driver
- `typescript` -- compiler

### No new runtime dependencies

Phase 3 introduces no new npm packages. All required functionality is covered by the existing stack.

### Dev dependencies (already present)

- `vitest` or `jest` -- test runner
- `supertest` or `light-my-request` -- HTTP testing (Fastify includes `inject` natively)

---

## 11. Acceptance Criteria

### WHI-14: Define recipe DB schema

- [ ] `src/db/schema/recipes.ts` defines the `recipes` table with all 12 columns matching the spec (id, userId, name, description, triggerPhrase, steps, integrations, permissions, outputFormat, isPublic, deletedAt, createdAt, updatedAt).
- [ ] `id` defaults to `gen_random_uuid()`.
- [ ] `userId` has a foreign key to `users.id` with `ON DELETE CASCADE`.
- [ ] `steps` column is `jsonb NOT NULL`.
- [ ] `outputFormat` defaults to `'text'`.
- [ ] `isPublic` defaults to `false`.
- [ ] Three indexes exist: `recipes_user_id_idx`, `recipes_trigger_phrase_idx`, `recipes_is_public_idx`.
- [ ] `RecipeStep`, `RecipeIntegration`, `RecipePermissions` types are exported.
- [ ] `Recipe` (select) and `NewRecipe` (insert) types are exported via `InferSelectModel` / `InferInsertModel`.
- [ ] Migration file is generated and applies cleanly to a fresh database.
- [ ] Schema is re-exported from `src/db/schema/index.ts`.

### WHI-15: POST /recipes -- create recipe

- [ ] `POST /recipes` returns 201 with the created recipe.
- [ ] Request body is validated: missing `name` or empty `steps` returns 400.
- [ ] Invalid step type (e.g. `"invalid"`) returns 400.
- [ ] `userId` is set from `request.user.id`, not from the request body.
- [ ] `outputFormat` defaults to `"text"` when omitted.
- [ ] Unauthenticated requests return 401.
- [ ] The recipe is persisted in the database.

### WHI-18: GET /recipes -- list user recipes

- [ ] `GET /recipes` returns 200 with `{ data, pagination }`.
- [ ] Only recipes belonging to the authenticated user are returned.
- [ ] Soft-deleted recipes (where `deletedAt IS NOT NULL`) are excluded.
- [ ] `search` query param filters by name (case-insensitive partial match).
- [ ] Default pagination is page=1, limit=20.
- [ ] `limit` values above 100 return 400.
- [ ] `pagination.total` reflects the filtered count, not the page size.
- [ ] Unauthenticated requests return 401.

### WHI-16: PUT /recipes/:id -- update recipe

- [ ] `PUT /recipes/:id` returns 200 with the updated recipe.
- [ ] Only the recipe owner can update (another user's recipe returns 404).
- [ ] Partial updates work: sending only `{ name: "new" }` updates the name and leaves other fields unchanged.
- [ ] `updatedAt` is refreshed on every update.
- [ ] Invalid UUID for `:id` returns 400.
- [ ] Non-existent recipe returns 404.
- [ ] Soft-deleted recipe returns 404.
- [ ] Empty body (no fields) returns 400.
- [ ] Unauthenticated requests return 401.
- [ ] Nullable fields (`description`, `triggerPhrase`, `integrations`, `permissions`) can be set to `null` to clear them.

### WHI-11: DELETE /recipes/:id -- delete recipe

- [ ] `DELETE /recipes/:id` returns 204 with no body.
- [ ] The recipe is soft-deleted (`deletedAt` set to current timestamp).
- [ ] The recipe is not physically removed from the database.
- [ ] Only the recipe owner can delete (another user's recipe returns 404).
- [ ] Non-existent recipe returns 404.
- [ ] Already-deleted recipe returns 404.
- [ ] Unauthenticated requests return 401.

### Cross-cutting

- [ ] All routes are registered under the `/recipes` prefix.
- [ ] All routes use the `authenticate` preHandler from Phase 2.
- [ ] Zod validation errors return 400 with structured error details.
- [ ] No raw SQL is used; all queries go through Drizzle ORM.
- [ ] `RecipeService` is a standalone class with no Fastify coupling (testable in isolation).
- [ ] ILIKE search parameter is safe from SQL injection (parameterized by Drizzle).

---

## Implementation Order

1. **WHI-14** -- Schema and migration first; everything depends on the table existing.
2. **WHI-15** -- POST endpoint, since it populates data for the other endpoints.
3. **WHI-18** -- GET list endpoint, for verifying created recipes.
4. **WHI-16** -- PUT update endpoint.
5. **WHI-11** -- DELETE endpoint last, since it is the simplest.

Each issue can be implemented and merged as a separate PR, or all five can be combined into a single Phase 3 PR with one commit per issue.
