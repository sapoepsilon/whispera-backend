# Phase 5: Auth Extensions -- Implementation Plan

Phase 5 extends the Phase 2 email/password JWT auth system with user-provided API keys (BYOK), OpenAI Codex OAuth ("Sign in with ChatGPT"), and a Stripe-powered credits/payment system.

---

## Table of Contents

1. [WHI-22: BYOK -- User-Provided API Keys](#whi-22-byok----user-provided-api-keys)
2. [WHI-29: OpenAI Codex OAuth](#whi-29-openai-codex-oauth)
3. [WHI-28: Whispera Credits / Payment System](#whi-28-whispera-credits--payment-system)
4. [Dropped Issue: WHI-27](#dropped-issue-whi-27)
5. [Shared Infrastructure](#shared-infrastructure)
6. [Environment Variables Summary](#environment-variables-summary)
7. [Migration and Rollout Order](#migration-and-rollout-order)

---

## WHI-22: BYOK -- Pass-Through API Keys

### Overview

Users bring their own API keys for any supported LLM provider. Keys are stored client-side (in the Mac/iOS Keychain) and passed to the backend with each request via a custom header. The backend uses the key for that single request and immediately discards it -- nothing is stored server-side.

This is the most secure BYOK pattern: if Whispera's database is breached, zero API keys are exposed because they were never stored there. The client app handles key persistence using the OS Keychain, which is purpose-built for secret storage.

### How It Works

1. User adds their API key in the Whispera Mac/iOS app settings
2. App stores the key in the OS Keychain (encrypted by the OS)
3. Every API request includes the key in a custom header: `X-Provider-Key: <api-key>`
4. Optionally includes the provider: `X-Provider: claude` or `X-Provider: openai`
5. The backend ProviderRouter reads the header, uses the key for the LLM call, then discards it
6. If no key header is present, falls back to Codex OAuth (OpenAI) or platform credits

### Backend Implementation

#### Request Header Convention

```
X-Provider-Key: sk-ant-api03-...    # the raw API key
X-Provider: claude                   # optional, auto-detected from key prefix if omitted
```

Key prefix auto-detection:
- `sk-ant-` → Claude (Anthropic)
- `sk-` → OpenAI
- If ambiguous, `X-Provider` header is required

#### `src/services/providers/router.ts` (modify)

The ProviderRouter's `getProvider` method is updated to accept a key from the request:

```ts
interface ProviderResolution {
  provider: LLMProvider;
  keySource: 'byok' | 'codex-oauth' | 'credits';
}

async resolveProvider(
  userId: string,
  requestKey?: string,
  requestProvider?: string,
): Promise<ProviderResolution> {
  // 1. If request includes X-Provider-Key, use it directly
  if (requestKey) {
    const provider = requestProvider ?? detectProviderFromKey(requestKey);
    return {
      provider: this.createProvider(provider, requestKey),
      keySource: 'byok',
    };
  }

  // 2. Check for Codex OAuth (OpenAI only)
  const oauthToken = await oauthConnectionService.getValidAccessToken(userId, 'openai-codex');
  if (oauthToken) {
    return {
      provider: this.createProvider('openai', oauthToken),
      keySource: 'codex-oauth',
    };
  }

  // 3. Fall back to platform key + credits
  if (await creditService.hasEnoughCredits(userId, estimatedCost)) {
    return {
      provider: this.createProvider(preferredProvider, platformKey),
      keySource: 'credits',
    };
  }

  throw new InsufficientCreditsError();
}

function detectProviderFromKey(key: string): string {
  if (key.startsWith('sk-ant-')) return 'claude';
  if (key.startsWith('sk-')) return 'openai';
  throw new Error('Cannot detect provider from key prefix. Set X-Provider header.');
}
```

#### `src/plugins/provider-key.ts` (create)

Fastify plugin that extracts the provider key from request headers and decorates the request:

```ts
import fp from 'fastify-plugin';

export default fp(async (fastify) => {
  fastify.decorateRequest('providerKey', undefined);
  fastify.decorateRequest('providerName', undefined);

  fastify.addHook('onRequest', async (request) => {
    const key = request.headers['x-provider-key'] as string | undefined;
    const provider = request.headers['x-provider'] as string | undefined;
    if (key) {
      request.providerKey = key;
      request.providerName = provider;
    }
  });
});
```

### Files to Create

| File | Purpose |
|------|---------|
| `src/plugins/provider-key.ts` | Extract X-Provider-Key header, decorate request |

### Files to Modify

| File | Change |
|------|--------|
| `src/services/providers/router.ts` | Add `resolveProvider()` with pass-through key support |
| `src/types/fastify.d.ts` | Add `providerKey` and `providerName` to `FastifyRequest` |

### Dependencies

- `@anthropic-ai/sdk` -- already needed by ProviderRouter for Claude calls
- `openai` -- already needed by ProviderRouter for OpenAI calls

No new packages. No database tables. No encryption service.

### Security Considerations

- **No server-side storage**: Keys exist in memory only for the duration of the request. Never logged, never persisted.
- **TLS only**: Keys travel over HTTPS. The `X-Provider-Key` header must never be logged by access logs or error handlers.
- **Header scrubbing**: Configure Fastify's logger to redact `x-provider-key` from request log output.
- **No key validation endpoint needed**: The key is validated implicitly when the LLM call succeeds or fails. A 401 from the provider means the key is bad.
- **Client responsibility**: The client app stores the key in the OS Keychain. The backend never needs to know the key between requests.

### What Was Removed (vs. original plan)

The original WHI-22 plan included server-side encrypted key storage. That has been replaced with this pass-through model. Removed:

- `src/db/schema/api-keys.ts` — no database table needed
- `src/services/crypto/index.ts` — no encryption needed for BYOK
- `src/services/api-keys/index.ts` — no key management service
- `src/services/api-keys/validators.ts` — validation happens implicitly
- `src/routes/auth/api-keys.ts` — no CRUD endpoints for keys
- `src/scripts/rotate-encryption-key.ts` — no keys to rotate
- `ENCRYPTION_KEY` env var — not needed for BYOK (still needed for WHI-29 OAuth tokens)

### Acceptance Criteria

- [ ] Requests with `X-Provider-Key` header use that key for the LLM call.
- [ ] Provider is auto-detected from key prefix (`sk-ant-` → Claude, `sk-` → OpenAI).
- [ ] `X-Provider` header overrides auto-detection.
- [ ] Key is never logged, stored, or persisted.
- [ ] Key is discarded after the request completes.
- [ ] Requests without `X-Provider-Key` fall through to Codex OAuth or credits.
- [ ] Invalid key returns the provider's error (401/403) to the client.
- [ ] `keySource` in response indicates how the key was resolved ('byok', 'codex-oauth', 'credits').

---

## WHI-29: OpenAI Codex OAuth

### Overview

OpenAI's Codex product exposes an OAuth 2.0 flow ("Sign in with ChatGPT") that lets third-party tools make API calls using a user's ChatGPT subscription (Plus, Pro, Business, Enterprise, Edu). This is the same flow used by OpenClaw, OpenCode, and the Codex CLI itself. OpenAI has confirmed this is usable by third-party tools — the Codex CLI is Apache-licensed and the terms are "quite permissive."

This gives Whispera users a zero-friction way to connect OpenAI: click "Sign in with ChatGPT," authenticate in the browser, and their subscription covers usage with no API key needed.

Reference: https://developers.openai.com/codex/auth

### Authentication Flow

PKCE-based OAuth 2.0:

1. Whispera generates a PKCE code verifier + challenge pair
2. Redirects user to OpenAI's authorization endpoint with `code_challenge`, `client_id`, `redirect_uri`, `scope`, and a signed `state` JWT
3. User authenticates with their ChatGPT credentials in the browser
4. OpenAI redirects back to Whispera's callback URL with an authorization `code`
5. Whispera exchanges the code + code verifier for access + refresh tokens
6. Tokens are encrypted (AES-256-GCM via crypto service from WHI-22) and stored
7. Access tokens are refreshed automatically before expiry

### Files to Create

#### `src/db/schema/oauth-connections.ts`

```ts
import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";

export const oauthConnections = pgTable("oauth_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 50 }).notNull(),
  accessToken: text("access_token").notNull(),
  accessTokenIv: varchar("access_token_iv", { length: 32 }).notNull(),
  accessTokenTag: varchar("access_token_tag", { length: 32 }).notNull(),
  refreshToken: text("refresh_token"),
  refreshTokenIv: varchar("refresh_token_iv", { length: 32 }),
  refreshTokenTag: varchar("refresh_token_tag", { length: 32 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope"),
  providerAccountId: varchar("provider_account_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userProviderUnique: uniqueIndex("oauth_connections_user_provider_idx").on(table.userId, table.provider),
}));
```

Unique index on `(userId, provider)` ensures one connection per provider per user. Reconnecting replaces the existing row.

#### `src/services/auth/oauth/openai-codex.ts`

```ts
import { randomBytes, createHash } from "node:crypto";

interface CodexTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  accountId: string | null;
}

export class OpenAICodexOAuthService {
  private clientId: string;
  private redirectUri: string;

  constructor() {
    this.clientId = requireEnv("OPENAI_CODEX_CLIENT_ID");
    this.redirectUri = requireEnv("OPENAI_CODEX_REDIRECT_URI");
  }

  generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://auth.openai.com/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<CodexTokenResponse> {
    // POST to https://auth.openai.com/oauth/token
    // Body: grant_type=authorization_code, code, redirect_uri, client_id, code_verifier
    // No client_secret needed (PKCE public client)
  }

  async refreshAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
    // POST to https://auth.openai.com/oauth/token
    // Body: grant_type=refresh_token, refresh_token, client_id
  }
}
```

PKCE means no client secret is needed — this is a public client flow suitable for apps where the secret cannot be kept confidential.

#### `src/services/auth/oauth/connection.ts`

Provider-agnostic OAuth connection management (shared if more OAuth providers are added later).

```ts
export class OAuthConnectionService {
  async upsert(userId: string, provider: string, tokens: CodexTokenResponse): Promise<void>;
  async get(userId: string, provider: string): Promise<DecryptedOAuthConnection | null>;
  async delete(userId: string, provider: string): Promise<void>;
  async getValidAccessToken(userId: string, provider: string): Promise<string | null>;
}
```

`getValidAccessToken` handles refresh transparently:
1. Fetch stored connection, decrypt access token
2. If `expiresAt` is in the future (5-minute buffer), return the access token
3. If expired and refresh token exists, call `refreshAccessToken`, encrypt new tokens, update row, return new access token
4. If expired and no refresh token, return `null` (user must re-authorize)

#### `src/routes/auth/oauth/openai.ts`

Three endpoints, all under `/auth/oauth/openai`:

**GET /auth/oauth/openai** -- Initiate OAuth flow (requires JWT auth)

1. Generate PKCE verifier + challenge
2. Generate a `state` JWT (5-minute expiry) containing `{ userId, provider: "openai-codex", nonce }`
3. Store verifier + nonce in a short-lived cache (in-memory Map with TTL, or Redis)
4. Return `{ url: string }` with the authorization URL

**GET /auth/oauth/openai/callback** -- Handle callback (public endpoint, browser redirect)

1. Verify `state` JWT, extract userId and nonce, validate nonce against cache
2. Exchange `code` + stored verifier for tokens
3. Encrypt and store tokens via `OAuthConnectionService.upsert(userId, "openai-codex", tokens)`
4. Redirect to frontend: `${FRONTEND_URL}/settings?oauth=openai&status=connected`

**DELETE /auth/oauth/openai** -- Disconnect (requires JWT auth)

1. Delete connection via `OAuthConnectionService.delete(userId, "openai-codex")`
2. Return 204

### ProviderRouter Integration

When the provider is OpenAI, the key resolution order becomes:

```
1. BYOK (user's own OpenAI API key)
2. Codex OAuth (user's ChatGPT subscription)
3. Platform key + credits
4. No key available -- error
```

BYOK takes precedence because a user who explicitly adds an API key probably wants to use it. Codex OAuth tokens route through the Codex backend (which uses subscription credits), while BYOK goes through the standard OpenAI API (which uses the user's API billing).

### Dependencies

No new npm packages. Uses Node.js built-in `crypto` for PKCE and `fetch` for token exchange.

### Security Considerations

- **PKCE**: Prevents authorization code interception. No client secret stored on the server.
- **State parameter**: Signed JWT with nonce prevents CSRF and replay attacks.
- **Token encryption**: Access and refresh tokens encrypted at rest with AES-256-GCM (same crypto service as BYOK).
- **Callback validation**: Never exchange a code without verifying the state JWT first.
- **Short-lived cache**: PKCE verifiers and nonces stored with 5-minute TTL to prevent replay.

### Acceptance Criteria

- [ ] `GET /auth/oauth/openai` returns `{ url }` pointing to OpenAI's authorization endpoint.
- [ ] URL contains `code_challenge`, `client_id`, `state`, and `redirect_uri` parameters.
- [ ] Returns 401 without auth.
- [ ] `GET /auth/oauth/openai/callback` with valid state + code stores encrypted tokens and redirects to frontend.
- [ ] Callback with invalid state redirects with `status=error`.
- [ ] `DELETE /auth/oauth/openai` removes the connection, returns 204.
- [ ] ProviderRouter uses Codex OAuth token when no BYOK exists for OpenAI.
- [ ] Expired tokens are automatically refreshed.
- [ ] User can have both a BYOK key and Codex OAuth connection (BYOK takes precedence).
- [ ] Reconnecting replaces the existing connection (upsert).

---

## WHI-28: Whispera Credits / Payment System

### Overview

A Stripe-integrated credit system. Users purchase credits, which are deducted when they use the platform's API keys to execute recipes. Users with their own keys (BYOK) are not charged credits for those provider calls. This is the fallback for users who do not want to manage their own API keys -- Whispera uses its own platform API keys on the user's behalf and charges credits for usage.

### Files to Create

#### `src/db/schema/credits.ts`

Two schema additions: a `creditBalance` column on the `users` table (or a separate `credit_balances` table) and a `credit_transactions` table for the ledger.

Option chosen: separate `credit_balances` table to avoid modifying the users table and to keep billing concerns decoupled.

```ts
import { pgTable, uuid, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const creditBalances = pgTable("credit_balances", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(), // positive = credit added, negative = credit spent
  type: varchar("type", { length: 20 }).notNull(), // "purchase", "usage", "refund", "bonus"
  stripePaymentId: varchar("stripe_payment_id", { length: 255 }),
  description: text("description"),
  recipeId: uuid("recipe_id"),
  executionId: uuid("execution_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

The `type` column uses a varchar constrained to known values at the application level rather than a Postgres enum, making it easier to add new types without a migration.

Indexes:

- Index on `creditTransactions.userId` + `createdAt` DESC for efficient recent transaction queries.
- Index on `creditTransactions.stripePaymentId` for webhook idempotency checks.
- Unique index on `creditBalances.userId`.

#### `src/config/pricing.ts`

Static pricing configuration. Credits per provider/model combination.

```ts
interface ModelPricing {
  inputCreditsPerToken: number;
  outputCreditsPerToken: number;
  flatCostPerCall: number; // minimum charge per API call
}

export const PRICING: Record<string, Record<string, ModelPricing>> = {
  claude: {
    "claude-sonnet-4-20250514": {
      inputCreditsPerToken: 0.003,
      outputCreditsPerToken: 0.015,
      flatCostPerCall: 1,
    },
    "claude-opus-4-20250514": {
      inputCreditsPerToken: 0.015,
      outputCreditsPerToken: 0.075,
      flatCostPerCall: 5,
    },
    // ...other models
  },
  openai: {
    "gpt-4o": {
      inputCreditsPerToken: 0.005,
      outputCreditsPerToken: 0.015,
      flatCostPerCall: 1,
    },
    // ...other models
  },
};

export const CREDIT_PACKAGES = [
  { credits: 100, priceUsd: 5, stripePriceId: "price_100_credits" },
  { credits: 500, priceUsd: 20, stripePriceId: "price_500_credits" },
  { credits: 2000, priceUsd: 60, stripePriceId: "price_2000_credits" },
];

export function calculateCreditCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number;
```

The `calculateCreditCost` function returns the total credit cost for a single API call. The result is always rounded up to the nearest integer.

#### `src/services/billing/credits.ts`

Credit management service.

```ts
export class CreditService {
  async getBalance(userId: string): Promise<number>;
  async getTransactions(userId: string, limit?: number, offset?: number): Promise<CreditTransaction[]>;
  async addCredits(userId: string, amount: number, type: string, metadata?: CreditMetadata): Promise<void>;
  async deductCredits(userId: string, amount: number, metadata: DeductionMetadata): Promise<void>;
  async hasEnoughCredits(userId: string, amount: number): Promise<boolean>;
}
```

Method details:

- `getBalance` -- Reads from `credit_balances`. If no row exists, returns 0.
- `getTransactions` -- Reads from `credit_transactions` ordered by `createdAt` DESC. Default limit: 50.
- `addCredits` -- Wraps in a database transaction:
  1. Upsert `credit_balances` (increment balance).
  2. Insert a row into `credit_transactions` with positive `amount`.
- `deductCredits` -- Wraps in a database transaction with a row-level lock on `credit_balances`:
  1. `SELECT ... FOR UPDATE` on the balance row.
  2. Verify `balance >= amount`. If not, throw `InsufficientCreditsError`.
  3. Decrement balance.
  4. Insert a row into `credit_transactions` with negative `amount`.
  The `FOR UPDATE` lock prevents race conditions where two concurrent recipe executions both pass the balance check and overdraw the account.
- `hasEnoughCredits` -- Convenience method that reads the balance without locking. Used for pre-flight checks before starting a recipe (not for the actual deduction).

```ts
interface CreditMetadata {
  stripePaymentId?: string;
  description?: string;
}

interface DeductionMetadata {
  recipeId: string;
  executionId: string;
  provider: string;
  model: string;
  description: string;
}
```

#### `src/services/billing/stripe.ts`

Stripe integration service.

```ts
import Stripe from "stripe";

export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
      apiVersion: "2024-12-18.acacia",
    });
  }

  async createCheckoutSession(
    userId: string,
    userEmail: string,
    creditPackage: { credits: number; stripePriceId: string }
  ): Promise<{ sessionId: string; url: string }> {
    // Create a Stripe Checkout Session in payment mode
    // Set metadata: { userId, credits: creditPackage.credits }
    // success_url and cancel_url point to the frontend
  }

  async constructWebhookEvent(payload: Buffer, signature: string): Promise<Stripe.Event> {
    // Verify the webhook signature using STRIPE_WEBHOOK_SECRET
    // Return the parsed event
  }

  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    // Extract userId and credits from session.metadata
    // Call CreditService.addCredits(userId, credits, "purchase", { stripePaymentId: session.payment_intent })
  }
}
```

#### `src/routes/billing/credits.ts`

Fastify route plugin for credit-related endpoints. All routes except the webhook require JWT auth.

**GET /billing/credits**

Returns the user's credit balance and recent transactions.

Response (200):

```ts
{
  balance: number;
  transactions: Array<{
    id: string;
    amount: number;
    type: "purchase" | "usage" | "refund" | "bonus";
    description: string | null;
    recipeId: string | null;
    executionId: string | null;
    createdAt: string;
  }>;
}
```

Query parameters:

- `limit`: number, default 50, max 100.
- `offset`: number, default 0.

**POST /billing/credits/purchase**

Creates a Stripe checkout session for purchasing credits.

Request body:

```ts
{
  packageId: string; // maps to a CREDIT_PACKAGES entry's stripePriceId
}
```

Response (200):

```ts
{
  sessionId: string;
  url: string; // Stripe checkout URL
}
```

Error cases:

- 400 if `packageId` does not match a known credit package.

**POST /billing/webhooks/stripe**

Stripe webhook endpoint. This is a public endpoint (no JWT auth) but is verified via the Stripe webhook signature.

This route must use `content-type: application/json` with raw body parsing. Fastify's default JSON parsing must be bypassed for this route so that the raw body is available for signature verification.

```ts
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => done(null, body)
);
```

Or configure this at the route level using Fastify's `config` option to avoid affecting other routes.

Flow:

1. Extract the `stripe-signature` header.
2. Call `StripeService.constructWebhookEvent(rawBody, signature)`.
3. If the event type is `checkout.session.completed`, call `StripeService.handleCheckoutCompleted`.
4. Return 200 `{ received: true }`.

Idempotency: Before adding credits, check if a `credit_transactions` row with the same `stripePaymentId` already exists. If it does, skip the credit addition and return 200 (Stripe may retry webhooks).

### Files to Modify

#### `src/db/schema/index.ts`

Add `export * from "./credits";`.

#### `src/routes/index.ts`

Register the billing route plugins.

#### Pipeline executor integration

The pipeline executor (the service that runs recipe steps) must be modified to integrate credit checking and deduction:

```
async function executeRecipeStep(userId, step, context) {
  const provider = step.provider;
  const model = step.model;

  // 1. Check for BYOK
  const byokKey = await apiKeyService.getDecryptedKey(userId, provider);
  if (byokKey) {
    return callProvider(provider, model, byokKey, step.prompt);
  }

  // 2. Use platform key with credit deduction
  const estimatedCost = calculateCreditCost(provider, model, estimatedInputTokens, 0);
  if (!await creditService.hasEnoughCredits(userId, estimatedCost)) {
    throw new InsufficientCreditsError("Not enough credits to execute this step");
  }

  const result = await callProvider(provider, model, platformKey, step.prompt);

  const actualCost = calculateCreditCost(
    provider,
    model,
    result.usage.inputTokens,
    result.usage.outputTokens
  );

  await creditService.deductCredits(userId, actualCost, {
    recipeId: context.recipeId,
    executionId: context.executionId,
    provider,
    model,
    description: `${provider}/${model} - ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
  });

  return result;
}
```

Design note: The pre-flight check uses `hasEnoughCredits` with an estimate, but the actual deduction uses the real token count from the API response. This means a user could theoretically go slightly negative if the response is much larger than estimated. This is acceptable -- the alternative (pre-deducting and refunding) adds complexity. The balance column allows negative values, and a negative balance simply means the user must purchase credits before their next execution.

### Dependencies

New npm packages:

- `stripe` -- Official Stripe Node.js SDK. Version: latest stable (currently ^17.x).

```bash
npm install stripe
```

### Security Considerations

- **Webhook signature verification**: The Stripe webhook endpoint must verify the `stripe-signature` header using `STRIPE_WEBHOOK_SECRET`. Never process unverified webhook events.
- **Raw body parsing**: The Stripe SDK requires the raw request body (as a `Buffer`) for signature verification. The route must be configured to bypass Fastify's default JSON parsing.
- **Idempotency**: Webhook handlers must be idempotent. Check for existing transactions with the same `stripePaymentId` before adding credits.
- **Race conditions**: Credit deduction uses `SELECT ... FOR UPDATE` to prevent double-spending in concurrent executions.
- **No negative balance abuse**: While the system allows a small negative balance (due to estimation vs. actual cost), the pre-flight `hasEnoughCredits` check prevents users with zero or negative balances from starting new executions.
- **PCI compliance**: Whispera never handles raw payment card data. All payment processing happens on Stripe's hosted checkout page.
- **Stripe API key security**: `STRIPE_SECRET_KEY` must be stored in a secrets manager. The `STRIPE_WEBHOOK_SECRET` is specific to each webhook endpoint and must be configured per environment.

### Acceptance Criteria

- [ ] `GET /billing/credits` returns the user's balance and recent transactions.
- [ ] `POST /billing/credits/purchase` creates a Stripe checkout session and returns the URL.
- [ ] The Stripe webhook correctly adds credits after a successful payment.
- [ ] Duplicate webhook deliveries do not result in double-crediting.
- [ ] Credits are deducted after a recipe step executes using the platform key.
- [ ] Users with insufficient credits cannot start a recipe execution.
- [ ] Users with BYOK keys are not charged credits for those provider calls.
- [ ] Credit transactions include the recipe ID, execution ID, and provider/model details.
- [ ] The Stripe webhook signature is verified before processing.

---

## Dropped Issue: WHI-27

### WHI-27: Claude OAuth Integration -- DROPPED

**Reason**: Anthropic does not offer OAuth for third-party applications. Anthropic explicitly banned third-party use of Claude subscription OAuth tokens, with enforcement beginning February 2026. The Anthropic Agent SDK docs state: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

Claude integration is fully covered by WHI-22 (BYOK). Users obtain an API key from the Anthropic console and provide it to Whispera. This is the same approach used by Cursor, Warp, JetBrains, and other tools.

**Future path**: Anthropic's "unless previously approved" clause means partner approval may be possible. See WHI-34 for the client-side Claude Code CLI wrapper approach that works today without partner approval.

---

## Shared Infrastructure

### Encryption Key Management

The `ENCRYPTION_KEY` environment variable is used by WHI-29 (Codex OAuth) for encrypting stored OAuth tokens. It must be:

- A 32-byte value represented as a 64-character hex string.
- Generated using a cryptographically secure random number generator: `openssl rand -hex 32`.
- Stored in a secrets manager, not in `.env` files committed to source control.
- Different per environment (development, staging, production).

Not needed for BYOK (WHI-22) since API keys are never stored server-side.

### ProviderRouter Key Resolution

The ProviderRouter's key resolution priority:

```
1. Pass-through BYOK (X-Provider-Key header)     -- free for the user, key not stored
2. Codex OAuth (OpenAI only, user's ChatGPT sub)  -- free for the user, tokens stored encrypted
3. Platform key + credits                          -- costs credits
4. No key available                                -- return error to user
```

If the request includes an `X-Provider-Key` header, that key is used directly with no credit charge and no server-side storage. For OpenAI, if no BYOK header is present but a Codex OAuth connection exists, the user's ChatGPT subscription covers the cost. If neither exists, the platform's own API key is used and the user is charged credits.

### Database Migrations

Two new migrations:

1. `create_oauth_connections_table` -- Creates the `oauth_connections` table for Codex OAuth tokens.
2. `create_credit_tables` -- Creates the `credit_balances` and `credit_transactions` tables.

Generate these using `npx drizzle-kit generate` after adding the schema files.

### Error Types

Create `src/errors/billing.ts`:

```ts
export class InsufficientCreditsError extends Error {
  readonly statusCode = 402;
  constructor(message = "Insufficient credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

export class InvalidApiKeyError extends Error {
  readonly statusCode = 422;
  constructor(provider: string) {
    super(`The provided API key for ${provider} is invalid`);
    this.name = "InvalidApiKeyError";
  }
}
```

---

## Environment Variables Summary

All new environment variables introduced by Phase 5:

| Variable | Required By | Description |
|---|---|---|
| `ENCRYPTION_KEY` | WHI-29 | 64-char hex string (32 bytes) for AES-256-GCM encryption of OAuth tokens |
| `OPENAI_CODEX_CLIENT_ID` | WHI-29 | OpenAI Codex OAuth client ID |
| `OPENAI_CODEX_REDIRECT_URI` | WHI-29 | OAuth callback URL (e.g., `https://api.whispera.com/auth/oauth/openai/callback`) |
| `STRIPE_SECRET_KEY` | WHI-28 | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | WHI-28 | Stripe webhook endpoint signing secret |
| `FRONTEND_URL` | WHI-28, WHI-29 | Frontend base URL for OAuth redirects and Stripe success/cancel URLs |

Add all variables to `.env.example` with placeholder values and instructions.

---

## Migration and Rollout Order

The two issues have a dependency that dictates the implementation order:

### Phase 5a: Pass-through BYOK (implement first)

1. **WHI-22: BYOK** -- no dependencies. Add the `provider-key` plugin that reads `X-Provider-Key` header, update ProviderRouter to use it. Delivers immediate user value with zero server-side storage.

### Phase 5b: OpenAI Codex OAuth (implement second)

2. **Crypto service** (`src/services/crypto/index.ts`) -- needed only for encrypting OAuth tokens.
3. **WHI-29: OpenAI Codex OAuth** -- depends on the crypto service. Adds the "Sign in with ChatGPT" flow.

### Phase 5c: Billing (implement last)

4. **WHI-28: Credits/Payment** -- depends on WHI-22 and WHI-29 because the credit deduction logic checks whether a user has a BYOK header or OAuth connection (to skip charging).

### Testing Strategy

Each issue should include:

- **Unit tests** for services (`ApiKeyService`, `CreditService`, `StripeService`, `encrypt/decrypt`).
- **Integration tests** for routes using Fastify's `inject()` method with a test database.
- **Stripe webhook tests** using Stripe's test mode and fixture events from `stripe.webhooks.constructEvent` with a test signing secret.
- **Encryption round-trip tests** to verify encrypt/decrypt produces the original plaintext.
- **Provider validation tests** with mocked SDK clients to verify key validation for both Claude and OpenAI.

### File Tree Summary

```
src/
  config/
    pricing.ts                          (WHI-28)
  db/
    schema/
      oauth-connections.ts              (WHI-29)
      credits.ts                        (WHI-28)
      index.ts                          (modify)
  errors/
    billing.ts                          (WHI-28)
  plugins/
    provider-key.ts                     (WHI-22)
  routes/
    auth/
      oauth/
        openai.ts                       (WHI-29)
    billing/
      credits.ts                        (WHI-28)
    index.ts                            (modify)
  services/
    auth/
      oauth/
        openai-codex.ts                 (WHI-29)
        connection.ts                   (WHI-29)
    billing/
      credits.ts                        (WHI-28)
      stripe.ts                         (WHI-28)
    crypto/
      index.ts                          (WHI-29 only)
```
