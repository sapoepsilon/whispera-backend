# Phase 1: API Foundation -- Implementation Plan

This document specifies every file, type, dependency, and acceptance criterion for Phase 1 of the Whispera backend. Phase 1 establishes the Fastify project scaffold, database layer, local development environment, step-execution pipeline, and LLM provider abstraction.

---

## Table of Contents

1. [WHI-7: Scaffold Fastify project with TypeScript](#whi-7-scaffold-fastify-project-with-typescript)
2. [WHI-6: Add health check and route autoload](#whi-6-add-health-check-and-route-autoload)
3. [WHI-8: Docker Compose for local dev](#whi-8-docker-compose-for-local-dev)
4. [WHI-9: Set up PostgreSQL with Drizzle ORM](#whi-9-set-up-postgresql-with-drizzle-orm)
5. [WHI-5: Design step execution pipeline](#whi-5-design-step-execution-pipeline)
6. [WHI-10: Implement provider router](#whi-10-implement-provider-router-claude--openai-adapters)

---

## WHI-7: Scaffold Fastify project with TypeScript

### Dependencies to install

```
pnpm init
pnpm add fastify @fastify/env @fastify/sensible
pnpm add -D typescript @types/node tsx tsconfig-paths eslint prettier eslint-config-prettier eslint-plugin-prettier @typescript-eslint/parser @typescript-eslint/eslint-plugin zod
```

### Files to create

#### `package.json`

After `pnpm init`, update the generated file with the following fields:

```jsonc
{
  "name": "whispera-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "tsx watch --tsconfig tsconfig.json src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "format": "prettier --write \"src/**/*.ts\"",
    "typecheck": "tsc --noEmit"
  }
}
```

The `db:*` scripts are added in the WHI-9 section below.

#### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "baseUrl": ".",
    "paths": {
      "@routes/*": ["src/routes/*"],
      "@plugins/*": ["src/plugins/*"],
      "@services/*": ["src/services/*"],
      "@models/*": ["src/models/*"],
      "@config/*": ["src/config/*"],
      "@db/*": ["src/db/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Note: Because we use `"module": "NodeNext"`, path aliases require a runtime resolver. In development, `tsx` with `tsconfig-paths` handles this. For production builds, either use `tsc-alias` as a post-build step or switch imports to relative paths in compiled output. Add `tsc-alias` to devDependencies and add a postbuild script:

```
pnpm add -D tsc-alias
```

Update the build script:

```json
"build": "tsc && tsc-alias"
```

#### `.eslintrc.cjs`

```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint", "prettier"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "plugin:prettier/recommended",
  ],
  rules: {
    "prettier/prettier": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "warn",
  },
  ignorePatterns: ["dist/", "node_modules/", "drizzle/"],
};
```

#### `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

#### `.gitignore`

```
node_modules/
dist/
.env
*.log
drizzle/meta/
```

#### Folder structure to create (empty directories)

```
src/
  routes/
  plugins/
  services/
  models/
  config/
  db/
    schema/
```

#### `src/config/env.ts`

This file defines and validates all environment variables using `@fastify/env` with a JSON Schema (which is what `@fastify/env` requires) and a companion Zod schema for type inference elsewhere in the app.

```ts
import { z } from 'zod';

export const envSchema = {
  type: 'object' as const,
  required: ['PORT', 'HOST', 'DATABASE_URL', 'JWT_SECRET', 'NODE_ENV'],
  properties: {
    PORT: { type: 'number' as const, default: 3000 },
    HOST: { type: 'string' as const, default: '0.0.0.0' },
    DATABASE_URL: { type: 'string' as const },
    JWT_SECRET: { type: 'string' as const },
    NODE_ENV: {
      type: 'string' as const,
      default: 'development',
      enum: ['development', 'production', 'test'],
    },
  },
};

export const zodEnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type EnvConfig = z.infer<typeof zodEnvSchema>;
```

#### `src/server.ts`

Entry point. Builds and starts the Fastify instance.

```ts
import Fastify from 'fastify';
import fastifyEnv from '@fastify/env';
import fastifySensible from '@fastify/sensible';
import { envSchema } from '@config/env.js';
import type { EnvConfig } from '@config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: EnvConfig;
  }
}

async function build() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(fastifyEnv, { schema: envSchema, dotenv: true });
  await app.register(fastifySensible);

  // Autoload plugin registered in WHI-6
  // Database plugin registered in WHI-9

  return app;
}

async function start() {
  const app = await build();

  try {
    const address = await app.listen({
      port: app.config.PORT,
      host: app.config.HOST,
    });
    app.log.info(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
```

Also install pino-pretty for dev logging:

```
pnpm add -D pino-pretty
```

### How it connects to other pieces

- `src/config/env.ts` is consumed by `src/server.ts` and any plugin/service that needs env vars.
- `src/server.ts` is the single entry point that wires all plugins and routes together.
- The `FastifyInstance` type augmentation (`declare module 'fastify'`) makes `app.config` strongly typed everywhere.

### Acceptance criteria

1. `pnpm install` succeeds with no errors.
2. `pnpm typecheck` passes with zero errors.
3. `pnpm lint` passes with zero errors.
4. `pnpm dev` starts the server, logging "Server listening at http://0.0.0.0:3000" (given a valid `.env`).
5. The folder structure `src/routes/`, `src/plugins/`, `src/services/`, `src/models/`, `src/config/`, `src/db/schema/` exists.
6. Path aliases (`@routes`, `@plugins`, `@services`, `@models`, `@config`, `@db`) resolve correctly in both dev (`tsx`) and build (`tsc && tsc-alias`) modes.

---

## WHI-6: Add health check and route autoload

### Dependencies to install

```
pnpm add @fastify/autoload
```

### Files to create / modify

#### `src/routes/health.ts`

```ts
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
}

export default async function healthRoute(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: getVersion(),
    };
  });
}
```

This file lives at `src/routes/health.ts`. Because it is at the root of `src/routes/`, autoload will register it with no prefix, making the endpoint `GET /health`.

#### `src/server.ts` (modify)

Add the autoload registration inside the `build()` function, after `fastifySensible`:

```ts
import autoload from '@fastify/autoload';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Inside build(), after sensible:
await app.register(autoload, {
  dir: join(__dirname, 'routes'),
  options: { prefix: '/' },
  encapsulate: false,
});
```

The `autoload` plugin recursively scans `src/routes/`. Any subdirectory becomes a route prefix. For example:

- `src/routes/health.ts` -> routes mounted at `/`
- `src/routes/api/recipes.ts` -> routes mounted at `/api`

Each route file must export a default async function that receives a `FastifyInstance`.

#### `src/plugins/` (modify)

Also register autoload for plugins so that Fastify plugins placed in `src/plugins/` are auto-registered:

```ts
await app.register(autoload, {
  dir: join(__dirname, 'plugins'),
  encapsulate: false,
});
```

Place this before the routes autoload in `build()`.

### How it connects to other pieces

- Autoload removes the need to manually import and register each route file. New route files placed in `src/routes/` are picked up automatically on restart.
- The health endpoint is the first route and serves as a smoke test for deployment readiness.
- The plugins autoload means the database plugin (WHI-9) and any future plugins are auto-registered by placing them in `src/plugins/`.

### Acceptance criteria

1. `GET /health` returns HTTP 200 with JSON body `{ "status": "ok", "timestamp": "<ISO string>", "version": "<version from package.json>" }`.
2. Adding a new file to `src/routes/some-dir/example.ts` that exports a default function with a `GET /test` route results in `GET /some-dir/test` being available without any manual import.
3. Plugins in `src/plugins/` are auto-registered.
4. All route files follow the `export default async function(fastify: FastifyInstance)` pattern.

---

## WHI-8: Docker Compose for local dev

### Files to create

#### `.env.example`

```
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://whispera:whispera_secret@localhost:5432/whispera
JWT_SECRET=change-me-to-a-random-string-at-least-32-chars
NODE_ENV=development
```

#### `Dockerfile`

Multi-stage build:

```dockerfile
# ---- Build stage ----
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/

RUN pnpm build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist dist/
COPY drizzle/ drizzle/

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

Notes on the Dockerfile:
- The `COPY drizzle/ drizzle/` line copies generated migration files so the production container can run migrations. If the `drizzle/` directory does not exist yet at build time, either remove this line until WHI-9 is complete or create the directory.
- The runtime stage only installs production dependencies (`--prod`), keeping the image small.

#### `.dockerignore`

```
node_modules
dist
.env
*.log
.git
.claude
```

#### `docker-compose.yml`

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: whispera
      POSTGRES_PASSWORD: whispera_secret
      POSTGRES_DB: whispera
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U whispera"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      PORT: 3000
      HOST: 0.0.0.0
      DATABASE_URL: postgresql://whispera:whispera_secret@postgres:5432/whispera
      JWT_SECRET: docker-dev-secret-change-in-production-at-least-32
      NODE_ENV: development

volumes:
  pgdata:
```

Key details:
- The `api` service uses `depends_on` with `condition: service_healthy` so it waits for Postgres to be ready before starting.
- The `DATABASE_URL` in the `api` service uses the Docker network hostname `postgres` (the service name), not `localhost`.
- The `.env.example` uses `localhost` because it is intended for running the API outside Docker while Postgres runs inside Docker.

### How it connects to other pieces

- The `Dockerfile` builds the TypeScript project and runs the compiled output.
- The `docker-compose.yml` provides the Postgres database that the Drizzle ORM layer (WHI-9) connects to.
- The `.env.example` serves as documentation for all required env vars defined in `src/config/env.ts` (WHI-7).

### Acceptance criteria

1. `docker compose up postgres -d` starts Postgres on port 5432 and data persists across restarts via the `pgdata` volume.
2. `docker compose up --build` builds the API image and starts both services. The API logs "Server listening" and `GET http://localhost:3000/health` returns 200.
3. `docker compose down` stops both services. `docker compose down -v` also removes the volume.
4. `.env.example` contains every variable defined in `src/config/env.ts` with sensible defaults.
5. The `.dockerignore` prevents `node_modules`, `dist`, `.env`, and `.git` from being sent to the Docker build context.

---

## WHI-9: Set up PostgreSQL with Drizzle ORM

### Dependencies to install

```
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

The `postgres` package is the `postgres.js` driver (not `pg`).

### Files to create / modify

#### `drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
```

Fields:
- `schema`: points to the barrel file that re-exports all schema tables.
- `out`: directory where drizzle-kit writes migration SQL files.
- `dialect`: `"postgresql"`.
- `dbCredentials.url`: reads `DATABASE_URL` from the environment at config-load time.
- `verbose` / `strict`: enable detailed output and strict mode for migration generation.

#### `src/db/schema/users.ts`

```ts
import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

Column details:
- `id`: UUID v4, primary key, generated by Postgres via `gen_random_uuid()`.
- `email`: varchar(255), NOT NULL, UNIQUE constraint.
- `passwordHash`: varchar(255), NOT NULL. Stores bcrypt/argon2 hash.
- `name`: varchar(255), nullable.
- `createdAt`: timestamptz, NOT NULL, defaults to `now()`.
- `updatedAt`: timestamptz, NOT NULL, defaults to `now()`, updated on every row change via Drizzle's `$onUpdate`.

The exported `User` type is the select shape (all fields present). `NewUser` is the insert shape (id/createdAt/updatedAt optional since they have defaults, name optional since nullable).

#### `src/db/schema/index.ts`

Barrel file that re-exports all schema modules.

```ts
export * from './users.js';
```

As new tables are added in future phases, add corresponding re-exports here.

#### `src/db/index.ts`

Database connection singleton.

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function createDb(connectionString: string) {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
}

export function getDb(connectionString: string) {
  if (!dbInstance) {
    dbInstance = createDb(connectionString);
  }
  return dbInstance;
}

export type Database = ReturnType<typeof createDb>;
```

Details:
- `createDb` creates a fresh Drizzle instance from a connection string. Used in tests where you want isolated connections.
- `getDb` returns a singleton. Used by the Fastify plugin.
- The `postgres()` client is configured with a max pool size of 10, idle timeout of 20 seconds, and connection timeout of 10 seconds.
- The schema is passed to `drizzle()` so that relational query API (e.g., `db.query.users.findMany()`) works.
- `Database` type is exported for use in service layers.

#### `src/plugins/db.ts`

Fastify plugin that decorates the instance with the database.

```ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { getDb, type Database } from '@db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

async function dbPlugin(fastify: FastifyInstance) {
  const db = getDb(fastify.config.DATABASE_URL);
  fastify.decorate('db', db);
  fastify.log.info('Database connection established');
}

export default fp(dbPlugin, {
  name: 'db',
  dependencies: [],
});
```

Install `fastify-plugin`:

```
pnpm add fastify-plugin
```

Key details:
- Uses `fastify-plugin` (`fp`) to break encapsulation so that `fastify.db` is available to all routes and plugins, not just siblings.
- The `declare module 'fastify'` block augments the `FastifyInstance` type so `fastify.db` is strongly typed as `Database`.
- Depends on `fastify.config.DATABASE_URL` being available, which means the `@fastify/env` plugin must be registered first. Since `src/plugins/db.ts` is auto-loaded, and `@fastify/env` is registered in `src/server.ts` before autoload, this ordering is guaranteed.

#### `package.json` (modify -- add scripts)

Add these scripts to the existing `scripts` object:

```json
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:push": "drizzle-kit push",
  "db:studio": "drizzle-kit studio"
}
```

What each does:
- `db:generate`: Reads the schema files, compares against the current migration history in `./drizzle/`, and generates new SQL migration files for any changes.
- `db:migrate`: Applies pending migration files from `./drizzle/` to the database specified by `DATABASE_URL`.
- `db:push`: Pushes the schema directly to the database without generating migration files. Useful during early development.
- `db:studio`: Opens Drizzle Studio, a browser-based GUI for inspecting/editing database contents.

All commands require `DATABASE_URL` to be set in the environment. The easiest way is to have a `.env` file in the project root (copied from `.env.example`).

### How it connects to other pieces

- The db plugin (`src/plugins/db.ts`) is auto-loaded by the plugin autoload registered in WHI-6. It depends on `fastify.config` from WHI-7.
- `src/db/schema/users.ts` defines the first table. Future schema files for recipes, steps, provider connections, etc. will be added to `src/db/schema/` and re-exported from `src/db/schema/index.ts`.
- `src/db/index.ts` is a standalone module usable outside Fastify (e.g., in migration scripts, CLI tools, tests).
- The Docker Compose Postgres service (WHI-8) provides the database that this layer connects to.

### Acceptance criteria

1. `pnpm db:generate` produces a migration SQL file in `./drizzle/` that creates the `users` table with all specified columns, constraints, and defaults.
2. `pnpm db:push` applies the schema to the running Postgres instance and the `users` table is queryable via `psql` or Drizzle Studio.
3. `pnpm db:studio` opens the Drizzle Studio UI showing the `users` table.
4. The Fastify app starts without errors, and `fastify.db` is available in route handlers.
5. `fastify.db.query.users.findMany()` returns an empty array (no users yet) without throwing.
6. The `User` and `NewUser` types correctly reflect the table shape (verified via IDE autocompletion / `pnpm typecheck`).
7. Adding a new schema file to `src/db/schema/`, re-exporting it from `index.ts`, and running `db:generate` produces a new migration.

---

## WHI-5: Design step execution pipeline

### Dependencies to install

None beyond what is already installed. This is pure TypeScript.

### Files to create

#### `src/services/pipeline/types.ts`

```ts
export enum StepType {
  LLM = 'llm',
  TOOL = 'tool',
  HTTP = 'http',
  SHELL = 'shell',
  SANDBOX = 'sandbox',
  APPROVAL = 'approval',
}

export interface Step {
  id: string;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
  /** If true, pipeline continues even if this step fails. Default: false. */
  optional?: boolean;
  /** Step timeout in milliseconds. Overrides the pipeline-level timeout for this step. */
  timeoutMs?: number;
}

export interface PipelineContext {
  /** Unique execution ID for tracing. */
  executionId: string;
  /** The user ID that triggered the pipeline. */
  userId: string;
  /** The recipe ID being executed. */
  recipeId: string;
  /** The original input (transcribed text from the user). */
  input: string;
  /** Accumulated variables that steps can read from and write to. */
  variables: Record<string, unknown>;
  /** AbortSignal for cancellation support. */
  signal?: AbortSignal;
}

export interface StepResult {
  stepId: string;
  stepType: StepType;
  success: boolean;
  /** The output data produced by this step. Passed as input to the next step. */
  output: unknown;
  /** Error message if success is false. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** ISO timestamp when the step started. */
  startedAt: string;
  /** ISO timestamp when the step finished. */
  finishedAt: string;
}

export interface PipelineResult {
  executionId: string;
  success: boolean;
  steps: StepResult[];
  /** The final output from the last successful step. */
  finalOutput: unknown;
  /** Total duration in milliseconds. */
  totalDurationMs: number;
}

export interface StepHandler {
  readonly type: StepType;
  execute(step: Step, input: unknown, context: PipelineContext): Promise<unknown>;
}
```

Field-by-field explanation:

**StepType enum**: Six variants covering every kind of step a recipe can contain. Only `LLM` gets a real handler in Phase 1; the rest are placeholders for future phases.

**Step interface**:
- `id`: Unique identifier for the step within the recipe. Used for result correlation and logging.
- `type`: Which `StepType` this step is.
- `name`: Human-readable label (e.g., "Summarize transcript").
- `config`: Step-type-specific configuration. For an LLM step this would include `provider`, `model`, `systemPrompt`, `temperature`, etc. For an HTTP step it would include `url`, `method`, `headers`, `body`. The shape is intentionally `Record<string, unknown>` because each handler knows its own config shape and validates internally.
- `optional`: When true, a failure in this step does not abort the pipeline.
- `timeoutMs`: Per-step timeout override.

**PipelineContext interface**:
- `executionId`: UUID generated at pipeline start. Used for logging, tracing, and correlating results.
- `userId`: The authenticated user running the recipe.
- `recipeId`: Which recipe is being executed.
- `input`: The original user input (transcribed speech). Passed as input to the first step.
- `variables`: A mutable key-value map. Steps can read from and write to this to share data outside the linear input/output chain (e.g., a step that extracts metadata can store it in `variables` for a later step to reference).
- `signal`: An `AbortSignal` for cooperative cancellation. Steps should check `signal.aborted` periodically and throw if aborted.

**StepResult interface**:
- `stepId` / `stepType`: Identify which step produced this result.
- `success`: Whether the step completed without error.
- `output`: The data produced. This becomes the `input` for the next step.
- `error`: Populated only when `success` is false.
- `durationMs`: Wall-clock time for the step.
- `startedAt` / `finishedAt`: ISO 8601 timestamps.

**PipelineResult interface**:
- Aggregates all step results plus the final output and total duration.

**StepHandler interface**:
- `type`: Which step type this handler processes.
- `execute`: Takes the step definition, the input from the previous step (or the original input for the first step), and the pipeline context. Returns the output for the next step. Throws on failure.

#### `src/services/pipeline/registry.ts`

```ts
import type { StepHandler } from './types.js';
import { StepType } from './types.js';

export class StepHandlerRegistry {
  private handlers = new Map<StepType, StepHandler>();

  register(handler: StepHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Handler for step type "${handler.type}" is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: StepType): StepHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(
        `No handler registered for step type "${type}". ` +
          `Registered types: ${[...this.handlers.keys()].join(', ')}`,
      );
    }
    return handler;
  }

  has(type: StepType): boolean {
    return this.handlers.has(type);
  }

  registeredTypes(): StepType[] {
    return [...this.handlers.keys()];
  }
}
```

Details:
- `register`: Adds a handler. Throws if a handler for that type is already registered (prevents accidental overwrites).
- `get`: Retrieves a handler by type. Throws with a descriptive error listing registered types if not found.
- `has`: Check without throwing.
- `registeredTypes`: Returns the list of currently registered types, useful for debugging and introspection.

#### `src/services/pipeline/executor.ts`

```ts
import type { Step, PipelineContext, StepResult, PipelineResult } from './types.js';
import type { StepHandlerRegistry } from './registry.js';

export class PipelineExecutor {
  constructor(
    private registry: StepHandlerRegistry,
    private defaultTimeoutMs: number = 30_000,
  ) {}

  async execute(steps: Step[], context: PipelineContext): Promise<PipelineResult> {
    const results: StepResult[] = [];
    let currentInput: unknown = context.input;
    let pipelineSuccess = true;
    const pipelineStart = Date.now();

    for (const step of steps) {
      if (context.signal?.aborted) {
        pipelineSuccess = false;
        break;
      }

      const handler = this.registry.get(step.type);
      const timeoutMs = step.timeoutMs ?? this.defaultTimeoutMs;
      const startedAt = new Date().toISOString();
      const stepStart = Date.now();

      let result: StepResult;

      try {
        const output = await this.executeWithTimeout(
          () => handler.execute(step, currentInput, context),
          timeoutMs,
          context.signal,
        );

        result = {
          stepId: step.id,
          stepType: step.type,
          success: true,
          output,
          durationMs: Date.now() - stepStart,
          startedAt,
          finishedAt: new Date().toISOString(),
        };

        currentInput = output;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        result = {
          stepId: step.id,
          stepType: step.type,
          success: false,
          output: null,
          error: errorMessage,
          durationMs: Date.now() - stepStart,
          startedAt,
          finishedAt: new Date().toISOString(),
        };

        if (!step.optional) {
          pipelineSuccess = false;
          results.push(result);
          break;
        }
      }

      results.push(result);
    }

    const lastSuccessful = results.filter((r) => r.success).at(-1);

    return {
      executionId: context.executionId,
      success: pipelineSuccess,
      steps: results,
      finalOutput: lastSuccessful?.output ?? null,
      totalDurationMs: Date.now() - pipelineStart,
    };
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Step timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Pipeline aborted'));
      };

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Pipeline aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      fn()
        .then((result) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
    });
  }
}
```

Execution flow:
1. Initialize `currentInput` to `context.input` (the user's transcribed speech).
2. Iterate steps sequentially.
3. For each step, look up the handler from the registry. Execute it with a timeout wrapper.
4. On success: store the result, set `currentInput` to the step's output for the next step.
5. On failure: if the step is `optional`, record the failure and continue with the same `currentInput`. If not optional, record the failure, set `pipelineSuccess = false`, and break.
6. Before each step, check `context.signal?.aborted` for cooperative cancellation.
7. Return a `PipelineResult` with all step results, the final output, and timing data.

The `executeWithTimeout` method races the handler's promise against a `setTimeout` and the `AbortSignal`. Whichever fires first wins.

#### `src/services/pipeline/index.ts`

Barrel file for the pipeline module.

```ts
export { StepType } from './types.js';
export type { Step, PipelineContext, StepResult, PipelineResult, StepHandler } from './types.js';
export { StepHandlerRegistry } from './registry.js';
export { PipelineExecutor } from './executor.js';
```

### How it connects to other pieces

- The `PipelineExecutor` is the core of recipe execution. In future phases, a route handler will receive a recipe ID, load the recipe's steps from the database, build a `PipelineContext`, and call `executor.execute(steps, context)`.
- The `StepHandlerRegistry` is populated at app startup. In Phase 1, only the LLM handler is registered (implemented in WHI-10 below, wired in a future phase). Adding a new step type in the future means: (1) implement `StepHandler`, (2) call `registry.register(handler)` at startup.
- The LLM step handler (Phase 4) will use the provider router (WHI-10) to select Claude or OpenAI and make the actual API call.
- The `PipelineContext.variables` map allows non-linear data flow: a step can write to `context.variables['extractedEmail']` and a later step can read it from its `config` or from `context.variables`.

### Acceptance criteria

1. `StepType` enum has exactly six values: `llm`, `tool`, `http`, `shell`, `sandbox`, `approval`.
2. `StepHandlerRegistry` correctly registers handlers and throws on duplicate registration or missing handler lookup.
3. `PipelineExecutor.execute()` processes steps sequentially, passing each step's output as the next step's input.
4. A step failure on a non-optional step aborts the pipeline and returns `success: false`.
5. A step failure on an optional step is recorded but execution continues.
6. Timeout: a step that exceeds its `timeoutMs` is rejected with a timeout error.
7. Abort: setting `signal.aborted` before or during execution stops the pipeline.
8. `PipelineResult` contains accurate `totalDurationMs`, per-step `durationMs`, and correct `finalOutput`.
9. All types compile without errors (`pnpm typecheck`).
10. The pipeline is extensible: implementing a new `StepHandler` and calling `registry.register()` is all that is needed to support a new step type.

---

## WHI-10: Implement provider router (Claude + OpenAI adapters)

### Dependencies to install

```
pnpm add @anthropic-ai/sdk openai
```

### Files to create

#### `src/services/providers/types.ts`

```ts
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequestOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /** Provider-specific options passed through without transformation. */
  providerOptions?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'unknown';
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  /** Only present on the final chunk (done=true). */
  usage?: LLMResponse['usage'];
  finishReason?: LLMResponse['finishReason'];
}

export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], options: LLMRequestOptions): Promise<LLMResponse>;
  stream(
    messages: Message[],
    options: LLMRequestOptions,
  ): AsyncIterableIterator<LLMStreamChunk>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** Organization ID (OpenAI-specific). */
  organizationId?: string;
}
```

Field-by-field:

**Message**: Unified message format used by all providers. The `role` field uses the common subset: `system`, `user`, `assistant`. Each adapter translates this to the provider's native format (Claude uses a separate `system` parameter, not a system message in the array).

**LLMRequestOptions**:
- `model`: Required. Model identifier, e.g., `"claude-sonnet-4-20250514"` or `"gpt-4o"`.
- `temperature`: Optional. 0-2 for OpenAI, 0-1 for Claude.
- `maxTokens`: Optional. Maximum tokens to generate.
- `topP`: Optional. Nucleus sampling.
- `stop`: Optional. Stop sequences.
- `providerOptions`: Escape hatch for provider-specific params that don't fit the unified interface.

**LLMResponse**:
- `content`: The generated text.
- `model`: The actual model used (may differ from requested if the provider aliases).
- `provider`: `"claude"` or `"openai"`.
- `usage`: Token counts in a unified shape.
- `finishReason`: Why generation stopped.

**LLMStreamChunk**:
- `content`: Text delta for this chunk.
- `done`: Whether this is the last chunk.
- `usage` and `finishReason`: Only populated on the final chunk.

**LLMProvider**: The interface every adapter implements.

**ProviderConfig**: Configuration for instantiating a provider adapter.

#### `src/services/providers/adapters/base.ts`

```ts
import type { LLMProvider, Message, LLMRequestOptions, LLMResponse, LLMStreamChunk } from '../types.js';

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string;

  abstract chat(messages: Message[], options: LLMRequestOptions): Promise<LLMResponse>;

  abstract stream(
    messages: Message[],
    options: LLMRequestOptions,
  ): AsyncIterableIterator<LLMStreamChunk>;

  protected extractSystemMessage(messages: Message[]): {
    systemMessage: string | undefined;
    userMessages: Message[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');
    const systemMessage = systemMessages.map((m) => m.content).join('\n\n') || undefined;
    return { systemMessage, userMessages };
  }

  protected normalizeFinishReason(reason: string | null | undefined): LLMResponse['finishReason'] {
    if (!reason) return 'unknown';

    const map: Record<string, LLMResponse['finishReason']> = {
      stop: 'stop',
      end_turn: 'stop',
      length: 'length',
      max_tokens: 'length',
      tool_use: 'tool_use',
      tool_calls: 'tool_use',
      content_filter: 'content_filter',
    };

    return map[reason] ?? 'unknown';
  }
}
```

The base class provides two shared utilities:
- `extractSystemMessage`: Separates system messages from the array, joining multiple system messages with double newlines. Claude requires the system prompt as a separate parameter, not as a message. This helper normalizes that.
- `normalizeFinishReason`: Maps provider-specific finish reason strings to the unified enum. Claude uses `end_turn` and `max_tokens`; OpenAI uses `stop` and `length`.

#### `src/services/providers/adapters/claude.ts`

```ts
import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';
import type {
  Message,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  ProviderConfig,
} from '../types.js';

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude';
  private client: Anthropic;
  private defaultModel: string;

  constructor(config: ProviderConfig) {
    super();
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';
  }

  async chat(messages: Message[], options: LLMRequestOptions): Promise<LLMResponse> {
    const { systemMessage, userMessages } = this.extractSystemMessage(messages);

    const response = await this.client.messages.create({
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      top_p: options.topP,
      stop_sequences: options.stop,
      system: systemMessage,
      messages: userMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content: textContent,
      model: response.model,
      provider: this.name,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finishReason: this.normalizeFinishReason(response.stop_reason),
    };
  }

  async *stream(
    messages: Message[],
    options: LLMRequestOptions,
  ): AsyncIterableIterator<LLMStreamChunk> {
    const { systemMessage, userMessages } = this.extractSystemMessage(messages);

    const stream = this.client.messages.stream({
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      top_p: options.topP,
      stop_sequences: options.stop,
      system: systemMessage,
      messages: userMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { content: event.delta.text, done: false };
      }
    }

    const finalMessage = await stream.finalMessage();

    yield {
      content: '',
      done: true,
      usage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
      },
      finishReason: this.normalizeFinishReason(finalMessage.stop_reason),
    };
  }
}
```

Key implementation details:
- The constructor takes a `ProviderConfig`. The API key comes from the user's connected account (stored in the database, decrypted at runtime), not from an env var. This allows per-user API keys.
- `chat`: Calls `client.messages.create()`. Claude requires `max_tokens` (not optional), so it defaults to 4096. The system message is extracted and passed as the `system` parameter. Response content blocks are filtered for `text` type and joined.
- `stream`: Uses `client.messages.stream()` which returns an async iterable of SSE events. Text deltas are yielded as `LLMStreamChunk` with `done: false`. After the stream completes, `stream.finalMessage()` provides usage stats, yielded as a final chunk with `done: true`.

#### `src/services/providers/adapters/openai.ts`

```ts
import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import type {
  Message,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  ProviderConfig,
} from '../types.js';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: ProviderConfig) {
    super();
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      organization: config.organizationId,
    });
    this.defaultModel = config.defaultModel ?? 'gpt-4o';
  }

  async chat(messages: Message[], options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stop,
    });

    const choice = response.choices[0];

    return {
      content: choice?.message?.content ?? '',
      model: response.model,
      provider: this.name,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      finishReason: this.normalizeFinishReason(choice?.finish_reason),
    };
  }

  async *stream(
    messages: Message[],
    options: LLMRequestOptions,
  ): AsyncIterableIterator<LLMStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stop,
      stream: true,
      stream_options: { include_usage: true },
    });

    let finishReason: LLMResponse['finishReason'] = 'unknown';
    let usage: LLMResponse['usage'] | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;

      if (choice?.finish_reason) {
        finishReason = this.normalizeFinishReason(choice.finish_reason);
      }

      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        };
      }

      if (delta?.content) {
        yield { content: delta.content, done: false };
      }
    }

    yield {
      content: '',
      done: true,
      usage,
      finishReason,
    };
  }
}
```

Key implementation details:
- OpenAI's chat completions API accepts system messages directly in the messages array, so no extraction is needed. The unified `Message` type maps directly.
- `chat`: Calls `client.chat.completions.create()` without `stream: true`. Extracts the first choice's content and usage.
- `stream`: Calls with `stream: true` and `stream_options: { include_usage: true }` (so the final chunk includes token counts). Text deltas are yielded. Usage and finish reason are captured from the stream and emitted in the final `done: true` chunk.

#### `src/services/providers/router.ts`

```ts
import type { LLMProvider, ProviderConfig } from './types.js';
import { ClaudeProvider } from './adapters/claude.js';
import { OpenAIProvider } from './adapters/openai.js';

export type ProviderName = 'claude' | 'openai';

export interface ProviderSelection {
  provider: ProviderName;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  organizationId?: string;
}

export class ProviderRouter {
  private providers = new Map<string, LLMProvider>();

  getProvider(selection: ProviderSelection): LLMProvider {
    const cacheKey = `${selection.provider}:${selection.apiKey}`;

    const cached = this.providers.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config: ProviderConfig = {
      apiKey: selection.apiKey,
      baseUrl: selection.baseUrl,
      defaultModel: selection.defaultModel,
      organizationId: selection.organizationId,
    };

    let provider: LLMProvider;

    switch (selection.provider) {
      case 'claude':
        provider = new ClaudeProvider(config);
        break;
      case 'openai':
        provider = new OpenAIProvider(config);
        break;
      default: {
        const exhaustive: never = selection.provider;
        throw new Error(`Unknown provider: ${exhaustive}`);
      }
    }

    this.providers.set(cacheKey, provider);
    return provider;
  }

  clearCache(): void {
    this.providers.clear();
  }
}
```

How the router works:
- `getProvider` accepts a `ProviderSelection` that specifies which provider to use and the credentials. The selection will come from the user's connected accounts stored in the database (future phase).
- Provider instances are cached by `provider:apiKey` so that repeated calls with the same credentials reuse the same SDK client instance. This is important because the Anthropic and OpenAI SDKs maintain HTTP keep-alive connections internally.
- The `switch` statement uses TypeScript's exhaustive check pattern (`const exhaustive: never = selection.provider`) to ensure that adding a new `ProviderName` union member causes a compile error until a corresponding case is added.
- `clearCache` is available for testing or when user credentials change.

#### `src/services/providers/index.ts`

Barrel file:

```ts
export type {
  Message,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ProviderConfig,
} from './types.js';
export { ClaudeProvider } from './adapters/claude.js';
export { OpenAIProvider } from './adapters/openai.js';
export { ProviderRouter, type ProviderName, type ProviderSelection } from './router.js';
```

### How it connects to other pieces

- The LLM step handler (Phase 4) will use the `ProviderRouter` to get the appropriate `LLMProvider` and call `chat()` or `stream()`.
- The `ProviderSelection` data (which provider and which API key) will come from the user's connected accounts table in the database (future schema addition).
- The `Message` type is the canonical message format used throughout the app. Recipe steps that involve LLM calls will produce `Message[]` arrays.
- Streaming support (`AsyncIterableIterator<LLMStreamChunk>`) enables Server-Sent Events or WebSocket responses to the client so the user sees tokens as they arrive.
- The provider router is instantiated once at app startup and shared across all requests. Individual provider instances are cached per-user-API-key.

### Acceptance criteria

1. `ClaudeProvider.chat()` sends a request to the Claude API and returns an `LLMResponse` with content, usage, and finish reason.
2. `ClaudeProvider.stream()` yields `LLMStreamChunk` objects with text deltas, followed by a final chunk with `done: true`, usage, and finish reason.
3. `OpenAIProvider.chat()` sends a request to the OpenAI API and returns an `LLMResponse`.
4. `OpenAIProvider.stream()` yields `LLMStreamChunk` objects.
5. System messages are correctly handled: extracted and passed as a separate `system` parameter for Claude; kept in the messages array for OpenAI.
6. `ProviderRouter.getProvider()` returns the correct provider type based on the `provider` field in `ProviderSelection`.
7. Provider instances are cached -- calling `getProvider` twice with the same provider+apiKey returns the same instance (verified by reference equality).
8. Adding a new value to the `ProviderName` union without adding a switch case causes a TypeScript compile error.
9. All types compile without errors (`pnpm typecheck`).
10. The adapters can be tested with real API keys via a manual integration test (not automated in CI).

---

## WHI-35: POST /transcribe -- Server-Side Speech-to-Text

### Dependencies to install

```
pnpm add @fastify/multipart
```

### Files to create

#### `src/routes/transcribe.ts`

```ts
import type { FastifyInstance } from 'fastify';

export default async function transcribeRoute(fastify: FastifyInstance) {
  fastify.post('/transcribe', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No audio file provided' });

    const allowedMimes = [
      'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm',
      'audio/ogg', 'audio/flac', 'audio/x-m4a',
    ];
    if (!allowedMimes.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Unsupported audio format' });
    }

    const buffer = await data.toBuffer();
    const language = data.fields.language?.value as string | undefined;

    const result = await fastify.transcriptionService.transcribe(
      request.user.sub,
      buffer,
      { filename: data.filename, mimetype: data.mimetype, language },
    );

    return reply.send(result);
  });
}
```

#### `src/services/transcription/index.ts`

```ts
import OpenAI from 'openai';
import { File } from 'node:buffer';

export interface TranscriptionResult {
  text: string;
  language: string | null;
  duration: number | null;
  provider: string;
}

export class TranscriptionService {
  async transcribe(
    userId: string,
    audioBuffer: Buffer,
    options: { filename: string; mimetype: string; language?: string },
  ): Promise<TranscriptionResult> {
    // 1. Resolve OpenAI key via ProviderRouter (BYOK -> OAuth -> credits)
    // 2. Create OpenAI client with resolved key
    // 3. Call openai.audio.transcriptions.create()
    // 4. Deduct credits if using platform key
    // 5. Return result
  }
}
```

The OpenAI Whisper API call:

```ts
const file = new File([audioBuffer], options.filename, { type: options.mimetype });
const transcription = await client.audio.transcriptions.create({
  file,
  model: 'whisper-1',
  language: options.language,
  response_format: 'verbose_json',
});
// transcription.text, transcription.language, transcription.duration
```

#### `src/plugins/transcription.ts`

Fastify plugin that decorates `fastify.transcriptionService`:

```ts
import fp from 'fastify-plugin';
import { TranscriptionService } from '../services/transcription/index.js';

export default fp(async (fastify) => {
  fastify.decorate('transcriptionService', new TranscriptionService());
});
```

Register `@fastify/multipart` in `src/server.ts`:

```ts
import multipart from '@fastify/multipart';
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
```

### Acceptance criteria

1. `POST /transcribe` with a valid audio file returns 200 with `{ text, language, duration, provider }`.
2. Returns 400 for missing audio file.
3. Returns 400 for unsupported audio format.
4. Returns 401 without auth.
5. File size limit: 25MB (returns 413 if exceeded).
6. Supported formats: wav, mp3, m4a, webm, ogg, flac.
7. Uses ProviderRouter for key resolution (BYOK/OAuth/credits).
8. Credits deducted when using platform key.
9. `language` field is optional; when provided, improves transcription accuracy.

---

## Implementation order

The issues have dependencies. Implement them in this order:

1. **WHI-7** (project scaffold) -- everything depends on this.
2. **WHI-6** (health check + autoload) -- depends on WHI-7 for the Fastify app.
3. **WHI-8** (Docker Compose) -- depends on WHI-7 for the Dockerfile build. Can be done in parallel with WHI-6.
4. **WHI-9** (Drizzle ORM) -- depends on WHI-7 (project structure), WHI-6 (plugin autoload), and WHI-8 (Postgres service).
5. **WHI-5** (pipeline) -- depends on WHI-7 (project structure). No runtime dependencies on other issues, so it can be done in parallel with WHI-8/WHI-9.
6. **WHI-10** (provider router) -- depends on WHI-7 (project structure). No runtime dependencies on other issues, so it can be done in parallel with WHI-5/WHI-8/WHI-9.

```
WHI-7 (scaffold)
  |
  +-- WHI-6 (health + autoload)
  |     |
  |     +-- WHI-9 (Drizzle ORM) <-- also needs WHI-8
  |
  +-- WHI-8 (Docker Compose)
  |     |
  |     +-- WHI-9 (Drizzle ORM)
  |
  +-- WHI-5 (pipeline) -- independent after WHI-7
  |
  +-- WHI-10 (provider router) -- independent after WHI-7
```

---

## Complete file tree after Phase 1

```
whispera-backend/
  .dockerignore
  .env.example
  .eslintrc.cjs
  .gitignore
  .prettierrc
  docker-compose.yml
  Dockerfile
  drizzle.config.ts
  package.json
  pnpm-lock.yaml
  tsconfig.json
  drizzle/
    (generated migration files after db:generate)
  src/
    server.ts
    config/
      env.ts
    db/
      index.ts
      schema/
        index.ts
        users.ts
    models/
      (empty, used in future phases)
    plugins/
      db.ts
    routes/
      health.ts
    services/
      pipeline/
        index.ts
        types.ts
        registry.ts
        executor.ts
      providers/
        index.ts
        types.ts
        router.ts
        adapters/
          base.ts
          claude.ts
          openai.ts
```

---

## All npm dependencies (summary)

### Production dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| fastify | latest | HTTP framework |
| @fastify/env | latest | Environment variable validation |
| @fastify/sensible | latest | Sensible defaults (error handling, etc.) |
| @fastify/autoload | latest | Auto-register routes and plugins |
| fastify-plugin | latest | Break Fastify encapsulation for plugins |
| drizzle-orm | latest | ORM / query builder |
| postgres | latest | PostgreSQL driver (postgres.js) |
| zod | latest | Schema validation (used in env config, future request validation) |
| @anthropic-ai/sdk | latest | Claude API client |
| openai | latest | OpenAI API client |

### Development dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| typescript | latest | TypeScript compiler |
| @types/node | latest | Node.js type definitions |
| tsx | latest | TypeScript execution for dev |
| tsconfig-paths | latest | Path alias resolution in dev |
| tsc-alias | latest | Path alias resolution in build output |
| drizzle-kit | latest | Migration generation and studio |
| eslint | latest | Linter |
| prettier | latest | Formatter |
| eslint-config-prettier | latest | Disable ESLint rules that conflict with Prettier |
| eslint-plugin-prettier | latest | Run Prettier as an ESLint rule |
| @typescript-eslint/parser | latest | TypeScript parser for ESLint |
| @typescript-eslint/eslint-plugin | latest | TypeScript-specific lint rules |
| pino-pretty | latest | Pretty-print logs in development |
