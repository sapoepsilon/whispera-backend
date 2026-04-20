# Phase 2: Authentication -- Implementation Plan

Linear issue: **WHI-21** -- Email/social auth (signup, login, sessions)

This document describes every file, type, dependency, and acceptance criterion required to implement JWT-based email + password authentication on the Whispera backend (Fastify + TypeScript + PostgreSQL + Drizzle ORM). Social providers (Google, Apple) are mentioned as future optional work and are out of scope for this phase.

---

## Table of Contents

1. [New npm Dependencies](#1-new-npm-dependencies)
2. [Environment Variables](#2-environment-variables)
3. [Database Schema: Refresh Tokens Table](#3-database-schema-refresh-tokens-table)
4. [Password Utilities](#4-password-utilities)
5. [Token Utilities](#5-token-utilities)
6. [Auth Plugin](#6-auth-plugin)
7. [Request Validation Schemas](#7-request-validation-schemas)
8. [Route File: Auth Endpoints](#8-route-file-auth-endpoints)
9. [Integration with Existing Pieces](#9-integration-with-existing-pieces)
10. [Migration Workflow](#10-migration-workflow)
11. [Full Acceptance Criteria Checklist](#11-full-acceptance-criteria-checklist)

---

## 1. New npm Dependencies

| Package | Purpose | Version guidance |
|---|---|---|
| `argon2` | Password hashing (Argon2id) | `^0.41` or latest |
| `@fastify/jwt` | JWT sign/verify integrated with Fastify decorators | `^9` (match Fastify 5.x) |
| `zod` | Request body validation schemas | `^3.23` (if not already installed in Phase 1) |
| `uuid` | Generate v4 UUIDs for refresh tokens (only if `crypto.randomUUID` is unavailable in target Node version) | `^11` |

Install command:

```bash
npm install argon2 @fastify/jwt zod
```

Dev dependencies (if not already present):

```bash
npm install -D @types/uuid
```

### How these connect

- `argon2` is consumed exclusively by `src/services/auth/password.ts`.
- `@fastify/jwt` is consumed exclusively by `src/plugins/auth.ts`, which decorates the Fastify instance and request.
- `zod` is consumed by `src/routes/auth/schemas.ts` for request validation.

---

## 2. Environment Variables

Add the following to `.env` (and `.env.example`):

```
JWT_SECRET=<random-64-char-hex-string>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
```

### File to modify: `src/config/env.ts` (or wherever Phase 1 centralises env parsing)

Add three new fields to the env schema/config object:

```ts
jwtSecret: string;       // required, non-empty
jwtAccessExpiry: string;  // default "15m"
jwtRefreshExpiry: string; // default "7d"
```

Validation: `jwtSecret` must be present and at least 32 characters. Fail fast at startup if missing.

### Acceptance criteria

- Server refuses to start when `JWT_SECRET` is missing or shorter than 32 characters.
- Default expiry values are applied when the env vars are absent.

---

## 3. Database Schema: Refresh Tokens Table

### File to create: `src/db/schema/refresh-tokens.ts`

```ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

### Field-level detail

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` | Row identifier |
| `userId` | `uuid` | NOT NULL, FK -> `users.id` ON DELETE CASCADE | Owning user |
| `token` | `text` | NOT NULL, UNIQUE | The opaque refresh token string. Indexed via unique constraint. |
| `expiresAt` | `timestamptz` | NOT NULL | When this refresh token becomes invalid |
| `revokedAt` | `timestamptz` | nullable | Set when the token is rotated or explicitly revoked. A non-null value means the token is dead. |
| `createdAt` | `timestamptz` | NOT NULL, default `now()` | Audit trail |

### File to modify: `src/db/schema/index.ts`

Re-export the new table:

```ts
export * from "./refresh-tokens";
```

### How it connects

- Referenced by `src/services/auth/tokens.ts` for insert, lookup, and revocation queries.
- The `userId` FK relies on the `users` table defined in Phase 1 (`src/db/schema/users.ts`).

### Acceptance criteria

- Running `npx drizzle-kit generate` produces a migration that creates the `refresh_tokens` table with all columns and constraints listed above.
- Running `npx drizzle-kit migrate` applies the migration without errors.
- Deleting a user cascades and removes their refresh tokens.

---

## 4. Password Utilities

### File to create: `src/services/auth/password.ts`

#### Exported functions

```ts
export async function hashPassword(plain: string): Promise<string>;
export async function verifyPassword(plain: string, hashed: string): Promise<boolean>;
```

#### Implementation detail

- `hashPassword` calls `argon2.hash(plain)` using Argon2id (the default variant in the `argon2` package). No custom options are needed; the library defaults (memory cost 65536 KiB, time cost 3, parallelism 4) are production-appropriate.
- `verifyPassword` calls `argon2.verify(hashed, plain)` and returns the boolean result. It must catch any `argon2` error (e.g., malformed hash) and return `false` rather than throwing.

#### Dependencies

- `argon2` (npm)

#### How it connects

- Called by `POST /auth/register` (hash) and `POST /auth/login` (verify).
- No other module depends on this file.

#### Acceptance criteria

- `hashPassword("test123")` returns a string starting with `$argon2id$`.
- `verifyPassword("test123", hashedValue)` returns `true`.
- `verifyPassword("wrong", hashedValue)` returns `false`.
- `verifyPassword("anything", "not-a-valid-hash")` returns `false` (does not throw).

---

## 5. Token Utilities

### File to create: `src/services/auth/tokens.ts`

#### Types

```ts
interface AccessTokenPayload {
  sub: string;   // user id (uuid)
  email: string;
}

interface RefreshTokenResult {
  token: string;     // opaque random string (hex, 64 chars)
  expiresAt: Date;   // UTC timestamp
}
```

#### Exported functions

```ts
export function generateAccessToken(
  fastify: FastifyInstance,
  user: { id: string; email: string }
): string;

export async function generateRefreshToken(
  db: DrizzleClient,
  user: { id: string }
): Promise<RefreshTokenResult>;

export async function verifyRefreshToken(
  db: DrizzleClient,
  token: string
): Promise<{ userId: string } | null>;

export async function revokeRefreshToken(
  db: DrizzleClient,
  token: string
): Promise<void>;
```

#### Implementation detail

**`generateAccessToken`**

- Calls `fastify.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: config.jwtAccessExpiry })`.
- Returns the signed JWT string.

**`generateRefreshToken`**

- Generates a cryptographically random 64-character hex string via `crypto.randomBytes(32).toString("hex")`.
- Computes `expiresAt` by adding the configured `JWT_REFRESH_EXPIRY` duration (parsed via a small helper -- e.g., `ms` package or manual parsing of "7d") to `new Date()`.
- Inserts a row into `refresh_tokens` with `userId`, `token`, and `expiresAt`.
- Returns `{ token, expiresAt }`.

**`verifyRefreshToken`**

- Queries `refresh_tokens` where `token` matches, `revokedAt IS NULL`, and `expiresAt > now()`.
- Returns `{ userId }` if found, `null` otherwise.

**`revokeRefreshToken`**

- Updates the matching row, setting `revokedAt = new Date()`.

#### Dependencies

- `@fastify/jwt` (via `fastify.jwt.sign`)
- `crypto` (Node built-in)
- Drizzle client and the `refreshTokens` schema

#### How it connects

- `generateAccessToken` is called by register, login, and refresh endpoints.
- `generateRefreshToken` is called by register, login, and refresh endpoints.
- `verifyRefreshToken` and `revokeRefreshToken` are called by the refresh endpoint.

#### Acceptance criteria

- `generateAccessToken` returns a valid JWT that decodes to `{ sub, email, iat, exp }`.
- The JWT expires in 15 minutes by default.
- `generateRefreshToken` inserts a row into `refresh_tokens` and returns a 64-char hex string.
- `verifyRefreshToken` returns `null` for expired tokens.
- `verifyRefreshToken` returns `null` for revoked tokens.
- `revokeRefreshToken` sets `revokedAt` to a non-null timestamp.

---

## 6. Auth Plugin

### File to create: `src/plugins/auth.ts`

This file is a Fastify plugin that will be auto-loaded by `@fastify/autoload` from the `src/plugins` directory (set up in Phase 1).

#### Decorators added

| Target | Name | Type | Description |
|---|---|---|---|
| `FastifyInstance` | `authenticate` | `preHandler` hook function | Verifies the `Authorization: Bearer <token>` header and rejects with 401 if invalid |
| `FastifyRequest` | `user` | `{ id: string; email: string }` | Populated by the `authenticate` hook after successful JWT verification |

#### Implementation outline

```ts
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";

export default fp(async (fastify) => {
  fastify.register(jwt, {
    secret: fastify.config.jwtSecret,
  });

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ error: "Unauthorized" });
      }
    }
  );
});
```

After `request.jwtVerify()` succeeds, `request.user` is automatically set by `@fastify/jwt` to the decoded payload (`{ sub, email, iat, exp }`). The route handlers access `request.user.sub` for the user ID and `request.user.email` for the email.

#### Type augmentation

Create or modify `src/types/fastify.d.ts`:

```ts
import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}
```

#### Dependencies

- `@fastify/jwt`
- `fastify-plugin` (wraps the plugin so decorators propagate to the parent scope)

#### How it connects

- Registered automatically via `@fastify/autoload` scanning `src/plugins`.
- Consumed by any route that calls `{ preHandler: [fastify.authenticate] }`.
- Depends on `fastify.config.jwtSecret` being available (set up in Phase 1 env config, extended in section 2 above).

#### Acceptance criteria

- After registering the plugin, `fastify.authenticate` exists and is a function.
- A request without an `Authorization` header to a protected route returns `401 { error: "Unauthorized" }`.
- A request with a valid Bearer token populates `request.user` with `{ sub, email }`.
- A request with an expired token returns 401.

---

## 7. Request Validation Schemas

### File to create: `src/routes/auth/schemas.ts`

#### Zod schemas

```ts
import { z } from "zod";

export const registerBodySchema = z.object({
  email: z
    .string()
    .email("Invalid email format"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  name: z
    .string()
    .min(1, "Name is required")
    .max(255),
});

export const loginBodySchema = z.object({
  email: z
    .string()
    .email("Invalid email format"),
  password: z
    .string()
    .min(1, "Password is required"),
});

export const refreshBodySchema = z.object({
  refreshToken: z
    .string()
    .min(1, "Refresh token is required"),
});
```

#### Inferred types

```ts
export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
```

#### Response types (used for route typing, not validated outbound)

```ts
export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfileResponse {
  id: string;
  email: string;
  name: string;
  createdAt: string; // ISO 8601
}
```

#### Fastify integration

Each route will parse the body with the corresponding Zod schema inside the handler (or via a shared `validateBody` preHandler). If validation fails, return `400` with structured error messages:

```ts
{
  error: "Validation failed",
  details: [
    { field: "password", message: "Password must be at least 8 characters" }
  ]
}
```

Alternatively, if Phase 1 integrates `zod` with Fastify's built-in schema validation (e.g., via `fastify-type-provider-zod`), use that integration instead and let Fastify handle 400 responses automatically. The implementation should match whichever pattern Phase 1 established.

#### Dependencies

- `zod`

#### How it connects

- Imported by `src/routes/auth/index.ts` for request validation and type inference.

#### Acceptance criteria

- `registerBodySchema.parse({ email: "bad", password: "short", name: "" })` throws a ZodError with at least 3 issues.
- `registerBodySchema.parse({ email: "a@b.com", password: "Abcdefg1", name: "Test" })` succeeds.
- `loginBodySchema.parse({ email: "a@b.com", password: "x" })` succeeds.
- `refreshBodySchema.parse({ refreshToken: "" })` throws.

---

## 8. Route File: Auth Endpoints

### File to create: `src/routes/auth/index.ts`

This file exports a default Fastify plugin function. It will be auto-loaded by `@fastify/autoload` and mounted at the `/auth` prefix (configured by the autoload `prefix` option or directory structure, as established in Phase 1).

---

### 8.1 POST /auth/register

#### Request

```
POST /auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "MyP@ss1word",
  "name": "Jane Doe"
}
```

#### Handler logic

1. Parse and validate body with `registerBodySchema`.
2. Check if a user with this email already exists by querying the `users` table.
   - If exists: return `409 { error: "Email already registered" }`.
3. Hash the password via `hashPassword(body.password)`.
4. Insert a new row into the `users` table with `email`, `passwordHash`, and `name`.
5. Generate an access token via `generateAccessToken(fastify, user)`.
6. Generate a refresh token via `generateRefreshToken(db, user)`.
7. Return `201`:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<hex-string>"
}
```

#### Error responses

| Status | Condition | Body |
|---|---|---|
| 400 | Validation failure | `{ error: "Validation failed", details: [...] }` |
| 409 | Email already exists | `{ error: "Email already registered" }` |

---

### 8.2 POST /auth/login

#### Request

```
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "MyP@ss1word"
}
```

#### Handler logic

1. Parse and validate body with `loginBodySchema`.
2. Query the `users` table for a row matching `email`.
   - If not found: return `401 { error: "Invalid email or password" }`.
3. Verify the password via `verifyPassword(body.password, user.passwordHash)`.
   - If false: return `401 { error: "Invalid email or password" }`.
4. Generate access token and refresh token (same as register).
5. Return `200`:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<hex-string>"
}
```

The error message is intentionally identical for "no such user" and "wrong password" to prevent email enumeration.

#### Error responses

| Status | Condition | Body |
|---|---|---|
| 400 | Validation failure | `{ error: "Validation failed", details: [...] }` |
| 401 | Wrong email or password | `{ error: "Invalid email or password" }` |

---

### 8.3 POST /auth/refresh

#### Request

```
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "<hex-string>"
}
```

#### Handler logic

1. Parse and validate body with `refreshBodySchema`.
2. Verify the refresh token via `verifyRefreshToken(db, body.refreshToken)`.
   - If null: return `401 { error: "Invalid or expired refresh token" }`.
3. Revoke the old refresh token via `revokeRefreshToken(db, body.refreshToken)` (token rotation).
4. Look up the user by `userId` from the verified token result.
5. Generate a new access token and a new refresh token.
6. Return `200`:

```json
{
  "accessToken": "<new-jwt>",
  "refreshToken": "<new-hex-string>"
}
```

#### Error responses

| Status | Condition | Body |
|---|---|---|
| 400 | Validation failure | `{ error: "Validation failed", details: [...] }` |
| 401 | Token invalid, expired, or revoked | `{ error: "Invalid or expired refresh token" }` |

---

### 8.4 GET /auth/me

#### Request

```
GET /auth/me
Authorization: Bearer <jwt>
```

#### Handler logic

1. Apply `preHandler: [fastify.authenticate]` on this route.
2. Extract `request.user.sub` (user ID) from the verified JWT.
3. Query the `users` table by ID.
   - If not found (edge case -- user deleted after token issued): return `404 { error: "User not found" }`.
4. Return `200`:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "Jane Doe",
  "createdAt": "2026-04-19T12:00:00.000Z"
}
```

Do NOT return `passwordHash` or any other sensitive field.

#### Error responses

| Status | Condition | Body |
|---|---|---|
| 401 | Missing or invalid Bearer token | `{ error: "Unauthorized" }` |
| 404 | User no longer exists | `{ error: "User not found" }` |

---

### Route file structure

```ts
import type { FastifyPluginAsync } from "fastify";

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/register
  fastify.post("/register", async (request, reply) => { /* ... */ });

  // POST /auth/login
  fastify.post("/login", async (request, reply) => { /* ... */ });

  // POST /auth/refresh
  fastify.post("/refresh", async (request, reply) => { /* ... */ });

  // GET /auth/me
  fastify.get("/me", { preHandler: [fastify.authenticate] }, async (request, reply) => { /* ... */ });
};

export default authRoutes;
```

#### Dependencies

- `src/services/auth/password.ts` (hashPassword, verifyPassword)
- `src/services/auth/tokens.ts` (generateAccessToken, generateRefreshToken, verifyRefreshToken, revokeRefreshToken)
- `src/routes/auth/schemas.ts` (validation schemas)
- `src/db/schema/users.ts` (users table)
- `src/db/schema/refresh-tokens.ts` (refresh_tokens table)
- `src/plugins/auth.ts` (fastify.authenticate decorator)
- Drizzle client from Phase 1 (e.g., `src/db/index.ts`)

#### How it connects

- Auto-loaded by `@fastify/autoload` from `src/routes/auth/index.ts`.
- The `/auth` prefix is derived from the directory name by autoload.
- The `authenticate` preHandler is provided by the auth plugin (loaded before routes because plugins load first).

#### Acceptance criteria

See section 11 for the full checklist covering all four endpoints.

---

## 9. Integration with Existing Pieces

### Phase 1 files that need modification

| File | Change |
|---|---|
| `src/config/env.ts` | Add `jwtSecret`, `jwtAccessExpiry`, `jwtRefreshExpiry` fields. |
| `src/db/schema/index.ts` | Add `export * from "./refresh-tokens"`. |
| `src/db/schema/users.ts` | Verify the table has `id` (uuid, pk), `email` (text, unique), `passwordHash` (text), `name` (text), `createdAt` (timestamptz). If `passwordHash` is missing, add it. |
| `.env.example` | Add the three new environment variables. |
| `src/types/fastify.d.ts` | Add type augmentations for `FastifyInstance.authenticate` and `@fastify/jwt` module. Create this file if it does not exist. |

### Dependency graph

```
src/plugins/auth.ts
  -> @fastify/jwt
  -> src/config/env.ts (jwtSecret)

src/routes/auth/index.ts
  -> src/routes/auth/schemas.ts (zod schemas)
  -> src/services/auth/password.ts (argon2)
  -> src/services/auth/tokens.ts
       -> src/db/schema/refresh-tokens.ts
       -> src/plugins/auth.ts (fastify.jwt.sign)
  -> src/db/schema/users.ts
  -> src/db/index.ts (drizzle client)
  -> src/plugins/auth.ts (fastify.authenticate)
```

### Loading order

1. `@fastify/autoload` loads `src/plugins/*` -- this registers `auth.ts` and makes `fastify.authenticate` and `fastify.jwt` available.
2. `@fastify/autoload` loads `src/routes/*` -- this registers `auth/index.ts` which can now reference `fastify.authenticate`.

This ordering is guaranteed by the standard Phase 1 scaffold where plugins are registered before routes.

---

## 10. Migration Workflow

After creating `src/db/schema/refresh-tokens.ts`:

```bash
npx drizzle-kit generate --name add-refresh-tokens
npx drizzle-kit migrate
```

This produces a SQL migration file in `drizzle/` (or wherever `drizzle.config.ts` points) that creates the `refresh_tokens` table.

If the `users` table needs a `passwordHash` column added (i.e., Phase 1 did not include it), also update `src/db/schema/users.ts` before running the migration generator so both changes are captured in one migration.

---

## 11. Full Acceptance Criteria Checklist

### Registration

- [ ] `POST /auth/register` with valid body returns `201` with `accessToken` and `refreshToken`.
- [ ] A new row exists in the `users` table with a hashed password (not plaintext).
- [ ] A new row exists in `refresh_tokens` linked to the created user.
- [ ] Registering with an already-used email returns `409`.
- [ ] Missing `name` field returns `400`.
- [ ] Password `"short1A"` (7 chars) returns `400`.
- [ ] Password `"alllowercase1"` (no uppercase) returns `400`.
- [ ] Password `"NoNumbersHere"` (no digit) returns `400`.
- [ ] Invalid email format returns `400`.

### Login

- [ ] `POST /auth/login` with correct credentials returns `200` with `accessToken` and `refreshToken`.
- [ ] Wrong password returns `401` with `"Invalid email or password"`.
- [ ] Non-existent email returns `401` with the same generic message (no enumeration).
- [ ] Missing fields return `400`.

### Token refresh

- [ ] `POST /auth/refresh` with a valid refresh token returns `200` with a new token pair.
- [ ] The old refresh token is revoked (`revokedAt` is set).
- [ ] Reusing the old refresh token after rotation returns `401`.
- [ ] An expired refresh token returns `401`.
- [ ] An empty or missing `refreshToken` field returns `400`.

### Get current user

- [ ] `GET /auth/me` with a valid access token returns `200` with `id`, `email`, `name`, `createdAt`.
- [ ] Response does NOT contain `passwordHash`.
- [ ] Missing `Authorization` header returns `401`.
- [ ] Expired JWT returns `401`.
- [ ] Malformed JWT returns `401`.

### Auth plugin

- [ ] `fastify.authenticate` is a function after plugin registration.
- [ ] The plugin reads `JWT_SECRET` from the env config.
- [ ] Type augmentations compile without errors.

### Database

- [ ] The `refresh_tokens` table is created by the Drizzle migration.
- [ ] The `token` column has a unique index.
- [ ] Deleting a user cascades to their refresh tokens.

### General

- [ ] All new files pass `tsc --noEmit` with no type errors.
- [ ] All new files pass the project linter (`npm run lint`).
- [ ] The server starts successfully with all required env vars set.
- [ ] The server fails fast if `JWT_SECRET` is missing.

---

## Summary of Files

### New files

| File | Purpose |
|---|---|
| `src/db/schema/refresh-tokens.ts` | Drizzle schema for the `refresh_tokens` table |
| `src/services/auth/password.ts` | `hashPassword` and `verifyPassword` using argon2 |
| `src/services/auth/tokens.ts` | `generateAccessToken`, `generateRefreshToken`, `verifyRefreshToken`, `revokeRefreshToken` |
| `src/plugins/auth.ts` | Fastify plugin registering `@fastify/jwt` and the `authenticate` decorator |
| `src/routes/auth/schemas.ts` | Zod validation schemas and TypeScript types for auth request/response bodies |
| `src/routes/auth/index.ts` | Route handlers for `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/me` |
| `src/types/fastify.d.ts` | Type augmentations for Fastify instance and `@fastify/jwt` (create or extend) |

### Modified files

| File | Change |
|---|---|
| `src/config/env.ts` | Add JWT-related env vars |
| `src/db/schema/index.ts` | Re-export `refresh-tokens` |
| `src/db/schema/users.ts` | Verify/add `passwordHash` column |
| `.env.example` | Add `JWT_SECRET`, `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY` |
