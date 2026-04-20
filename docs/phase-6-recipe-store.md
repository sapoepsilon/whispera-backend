# Phase 6: Recipe Store -- Implementation Plan

## Overview

Phase 6 introduces a public recipe store where users can publish personal recipes for community discovery, browse and search published recipes, rate and review them, and install community recipes into their own accounts. This phase builds on top of the existing recipes CRUD (Phase 4), recipe execution (Phase 5), and auth (Phase 3) infrastructure.

---

## Table of Contents

1. [WHI-20: Define store DB schema (published recipes)](#whi-20-define-store-db-schema-published-recipes)
2. [WHI-13: GET /store -- browse public recipes](#whi-13-get-store----browse-public-recipes)
3. [WHI-23: GET /store/:id -- get recipe details](#whi-23-get-storeid----get-recipe-details)
4. [WHI-25: POST /store/publish -- publish user recipe](#whi-25-post-storepublish----publish-user-recipe)
5. [WHI-26: POST /store/:id/install -- install recipe to user](#whi-26-post-storeidinstall----install-recipe-to-user)
6. [Shared infrastructure: service, routes, and validation schemas](#shared-infrastructure)
7. [Migration and rollback strategy](#migration-and-rollback-strategy)

---

## WHI-20: Define store DB schema (published recipes)

### Files to create

#### `src/db/schema/store-recipes.ts`

```typescript
import { pgTable, uuid, varchar, text, jsonb, integer, decimal, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { recipes } from "./recipes";

export const STORE_RECIPE_CATEGORIES = [
  "writing",
  "coding",
  "research",
  "productivity",
  "creative",
  "analysis",
] as const;

export type StoreRecipeCategory = (typeof STORE_RECIPE_CATEGORIES)[number];

export const STORE_RECIPE_STATUSES = [
  "published",
  "unpublished",
  "flagged",
  "removed",
] as const;

export type StoreRecipeStatus = (typeof STORE_RECIPE_STATUSES)[number];

export const storeRecipes = pgTable(
  "store_recipes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    originalRecipeId: uuid("original_recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "set null" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    steps: jsonb("steps").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    tags: jsonb("tags").default([]),
    version: integer("version").default(1).notNull(),
    installCount: integer("install_count").default(0).notNull(),
    rating: decimal("rating", { precision: 3, scale: 2 }).default("0.00").notNull(),
    ratingCount: integer("rating_count").default(0).notNull(),
    status: varchar("status", { length: 20 }).default("published").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    categoryIdx: index("store_recipes_category_idx").on(table.category),
    tagsIdx: index("store_recipes_tags_idx").using("gin", table.tags),
    statusIdx: index("store_recipes_status_idx").on(table.status),
    installCountIdx: index("store_recipes_install_count_idx").on(table.installCount),
    ratingIdx: index("store_recipes_rating_idx").on(table.rating),
    authorIdIdx: index("store_recipes_author_id_idx").on(table.authorId),
  })
);

export type StoreRecipe = typeof storeRecipes.$inferSelect;
export type NewStoreRecipe = typeof storeRecipes.$inferInsert;
```

**Field-level detail:**

| Field | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PK, auto-generated | Unique identifier for the store listing |
| `originalRecipeId` | UUID | FK to `recipes.id`, NOT NULL | Links back to the source recipe in the user's collection. `onDelete: "set null"` so the store listing survives if the user deletes their personal copy. Note: the FK reference type in Drizzle requires the column itself to be nullable if `set null` is used -- see migration notes below. |
| `authorId` | UUID | FK to `users.id`, NOT NULL, cascade delete | The user who published the recipe. Cascade ensures cleanup if user is deleted. |
| `name` | VARCHAR(255) | NOT NULL | Display name in the store |
| `description` | TEXT | NOT NULL | Required for the store -- must explain what the recipe does |
| `steps` | JSONB | NOT NULL | Snapshot of recipe steps at publish time. Decoupled from the personal recipe. |
| `category` | VARCHAR(100) | NOT NULL | One of the predefined categories for filtering |
| `tags` | JSONB | DEFAULT `[]` | Array of free-form string tags for discovery |
| `version` | INTEGER | DEFAULT 1, NOT NULL | Incremented on each re-publish |
| `installCount` | INTEGER | DEFAULT 0, NOT NULL | Tracks how many users installed this recipe |
| `rating` | DECIMAL(3,2) | DEFAULT 0.00, NOT NULL | Computed average rating (0.00--5.00) |
| `ratingCount` | INTEGER | DEFAULT 0, NOT NULL | Number of ratings received |
| `status` | VARCHAR(20) | DEFAULT 'published', NOT NULL | Lifecycle state: published, unpublished, flagged, removed |
| `publishedAt` | TIMESTAMP WITH TZ | DEFAULT NOW(), NOT NULL | When first published |
| `updatedAt` | TIMESTAMP WITH TZ | DEFAULT NOW(), NOT NULL, auto-update | Last modification timestamp |

**Important note on `originalRecipeId`:** The schema specifies `onDelete: "set null"` so that if a user deletes their personal recipe, the published store recipe persists. However, Drizzle requires the column to be nullable for `set null` to work at the DB level. The column should therefore be:

```typescript
originalRecipeId: uuid("original_recipe_id")
  .references(() => recipes.id, { onDelete: "set null" }),
```

(Remove `.notNull()` to allow the set-null behavior.)

---

#### `src/db/schema/store-reviews.ts`

```typescript
import { pgTable, uuid, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { storeRecipes } from "./store-recipes";
import { users } from "./users";

export const storeReviews = pgTable(
  "store_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeRecipeId: uuid("store_recipe_id")
      .notNull()
      .references(() => storeRecipes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    storeRecipeIdIdx: index("store_reviews_store_recipe_id_idx").on(table.storeRecipeId),
    userIdIdx: index("store_reviews_user_id_idx").on(table.userId),
    uniqueUserReview: uniqueIndex("store_reviews_user_recipe_unique").on(
      table.storeRecipeId,
      table.userId
    ),
  })
);

export type StoreReview = typeof storeReviews.$inferSelect;
export type NewStoreReview = typeof storeReviews.$inferInsert;
```

**Field-level detail:**

| Field | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PK, auto-generated | Unique identifier for the review |
| `storeRecipeId` | UUID | FK to `store_recipes.id`, NOT NULL, cascade | The recipe being reviewed |
| `userId` | UUID | FK to `users.id`, NOT NULL, cascade | The reviewer |
| `rating` | INTEGER | NOT NULL, validated 1--5 at app level | Star rating |
| `comment` | TEXT | NULLABLE | Optional text review |
| `createdAt` | TIMESTAMP WITH TZ | DEFAULT NOW(), NOT NULL | When the review was posted |

**Unique constraint:** `(storeRecipeId, userId)` -- one review per user per recipe. Subsequent submissions update the existing review.

---

#### `src/db/schema/index.ts` (modify)

Add the new table exports to the barrel file:

```typescript
export * from "./store-recipes";
export * from "./store-reviews";
```

---

### Files to modify

#### `src/db/schema/recipes.ts` (modify)

Add a column to track where a recipe was installed from:

```typescript
installedFromStoreId: uuid("installed_from_store_id")
  .references(() => storeRecipes.id, { onDelete: "set null" }),
```

This nullable FK links a personal recipe back to the store recipe it was installed from. It serves two purposes:
- Prevents ambiguity about a recipe's origin
- Could support future "check for updates" functionality

**Circular reference note:** `recipes` references `storeRecipes` via `installedFromStoreId`, and `storeRecipes` references `recipes` via `originalRecipeId`. In Drizzle ORM, this requires using the callback form for at least one of the references to avoid circular import issues. The recommended approach is to define the `installedFromStoreId` reference using `relations()` instead of inline `.references()`, or to use a raw SQL migration for one of the two FKs.

---

### Migration

#### `src/db/migrations/XXXX_add_store_tables.ts`

Run `npx drizzle-kit generate` to produce the migration. The generated SQL should include:

1. `CREATE TABLE store_recipes (...)` with all columns and defaults
2. `CREATE TABLE store_reviews (...)` with all columns and defaults
3. All indexes listed above (category, tags GIN, status, installCount, rating, authorId, storeRecipeId, userId)
4. The unique constraint on `(store_recipe_id, user_id)` in `store_reviews`
5. `ALTER TABLE recipes ADD COLUMN installed_from_store_id UUID REFERENCES store_recipes(id) ON DELETE SET NULL`

Verify the GIN index on `tags` is created correctly:

```sql
CREATE INDEX store_recipes_tags_idx ON store_recipes USING gin (tags);
```

### Dependencies

- `src/db/schema/users.ts` (existing -- Phase 2)
- `src/db/schema/recipes.ts` (existing -- Phase 4)
- `drizzle-orm` and `drizzle-kit` packages (existing)

### How it connects to existing pieces

- `store_recipes.authorId` references the `users` table from Phase 2
- `store_recipes.originalRecipeId` references the `recipes` table from Phase 4
- `recipes.installedFromStoreId` creates the reverse link from personal recipes to store recipes
- The `store_reviews` table is entirely new and only references store-phase tables and `users`

### Acceptance criteria

- [ ] Running `npx drizzle-kit generate` produces a valid migration with both tables
- [ ] Running `npx drizzle-kit migrate` applies the migration without errors
- [ ] The `store_recipes` table exists with all 14 columns and correct types/defaults
- [ ] The `store_reviews` table exists with all 5 columns and correct types/defaults
- [ ] All 6 indexes on `store_recipes` are created (verify with `\di` in psql)
- [ ] The GIN index on `tags` supports `@>` containment queries
- [ ] The unique constraint on `store_reviews(store_recipe_id, user_id)` prevents duplicate reviews
- [ ] The `recipes` table has the new `installed_from_store_id` nullable column
- [ ] Foreign key cascades work: deleting a user cascades to their store recipes and reviews
- [ ] Foreign key set-null works: deleting a personal recipe sets `original_recipe_id` to NULL on the store recipe

---

## WHI-13: GET /store -- browse public recipes

### Files to create/modify

#### `src/routes/store/schemas.ts` (create -- shared across all store routes)

```typescript
import { z } from "zod";
import { STORE_RECIPE_CATEGORIES } from "../../db/schema/store-recipes";

export const browseStoreQuerySchema = z.object({
  category: z
    .enum(STORE_RECIPE_CATEGORIES)
    .optional(),
  search: z
    .string()
    .max(200)
    .optional(),
  tags: z
    .string()
    .optional()
    .transform((val) => val?.split(",").map((t) => t.trim()).filter(Boolean)),
  sort: z
    .enum(["popular", "newest", "top-rated"])
    .default("popular"),
  page: z
    .coerce.number()
    .int()
    .min(1)
    .default(1),
  limit: z
    .coerce.number()
    .int()
    .min(1)
    .max(100)
    .default(20),
});

export type BrowseStoreQuery = z.infer<typeof browseStoreQuerySchema>;
```

#### `src/services/store/index.ts` (create)

The `StoreService` class. The `browse` method:

```typescript
import { and, eq, desc, sql, ilike, or, SQL } from "drizzle-orm";
import { db } from "../../db";
import { storeRecipes } from "../../db/schema/store-recipes";
import { storeReviews } from "../../db/schema/store-reviews";
import { users } from "../../db/schema/users";
import { recipes } from "../../db/schema/recipes";
import type { BrowseStoreQuery } from "../../routes/store/schemas";

export class StoreService {
  async browse(query: BrowseStoreQuery): Promise<{
    data: StoreRecipeListItem[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const conditions: SQL[] = [eq(storeRecipes.status, "published")];

    if (query.category) {
      conditions.push(eq(storeRecipes.category, query.category));
    }

    if (query.search) {
      conditions.push(
        or(
          ilike(storeRecipes.name, `%${query.search}%`),
          ilike(storeRecipes.description, `%${query.search}%`)
        )!
      );
    }

    if (query.tags && query.tags.length > 0) {
      conditions.push(
        sql`${storeRecipes.tags} @> ${JSON.stringify(query.tags)}::jsonb`
      );
    }

    const where = and(...conditions);

    const orderByMap = {
      popular: desc(storeRecipes.installCount),
      newest: desc(storeRecipes.publishedAt),
      "top-rated": desc(storeRecipes.rating),
    };

    const offset = (query.page - 1) * query.limit;

    const [items, countResult] = await Promise.all([
      db
        .select({
          id: storeRecipes.id,
          name: storeRecipes.name,
          description: storeRecipes.description,
          category: storeRecipes.category,
          tags: storeRecipes.tags,
          installCount: storeRecipes.installCount,
          rating: storeRecipes.rating,
          ratingCount: storeRecipes.ratingCount,
          publishedAt: storeRecipes.publishedAt,
          authorId: users.id,
          authorName: users.name,
        })
        .from(storeRecipes)
        .innerJoin(users, eq(storeRecipes.authorId, users.id))
        .where(where)
        .orderBy(orderByMap[query.sort])
        .limit(query.limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(storeRecipes)
        .where(where),
    ]);

    return {
      data: items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        category: item.category,
        tags: item.tags as string[],
        installCount: item.installCount,
        rating: Number(item.rating),
        ratingCount: item.ratingCount,
        publishedAt: item.publishedAt,
        author: { id: item.authorId, name: item.authorName },
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: countResult[0].count,
      },
    };
  }
}
```

**Key interface:**

```typescript
interface StoreRecipeListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  installCount: number;
  rating: number;
  ratingCount: number;
  publishedAt: Date;
  author: { id: string; name: string };
}

interface BrowseStoreResponse {
  data: StoreRecipeListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}
```

#### `src/routes/store/index.ts` (create)

```typescript
import type { FastifyInstance } from "fastify";
import { StoreService } from "../../services/store";
import { browseStoreQuerySchema } from "./schemas";

const storeService = new StoreService();

export async function storeRoutes(fastify: FastifyInstance) {
  fastify.get("/store", async (request, reply) => {
    const query = browseStoreQuerySchema.parse(request.query);
    const result = await storeService.browse(query);
    return reply.send(result);
  });
}
```

**Route registration:** In the main app file (likely `src/app.ts` or `src/server.ts`), register the store routes:

```typescript
import { storeRoutes } from "./routes/store";
app.register(storeRoutes);
```

### Dependencies

- `src/db/schema/store-recipes.ts` (WHI-20)
- `src/db/schema/users.ts` (existing)
- `zod` (existing)
- `drizzle-orm` query builder (existing)
- Fastify instance (existing)

### How it connects to existing pieces

- This is a **public endpoint** -- no auth middleware is applied. The existing auth middleware from Phase 3 is not used here, though it could optionally be applied in a non-blocking way for future personalization (e.g., marking recipes the user has already installed).
- The route joins `store_recipes` with `users` to include author info, reusing the existing `users` table.
- Full-text search uses `ILIKE` for simplicity. If performance becomes an issue, a dedicated `tsvector` column with a GIN index can be added later.

### Acceptance criteria

- [ ] `GET /store` returns 200 with `{ data: [], pagination: { page: 1, limit: 20, total: 0 } }` when no recipes are published
- [ ] `GET /store?category=coding` filters results to only "coding" category recipes
- [ ] `GET /store?search=summarize` returns recipes whose name or description contains "summarize" (case-insensitive)
- [ ] `GET /store?tags=ai,writing` returns recipes tagged with both "ai" and "writing"
- [ ] `GET /store?sort=newest` returns results ordered by `publishedAt` descending
- [ ] `GET /store?sort=top-rated` returns results ordered by `rating` descending
- [ ] `GET /store?sort=popular` (or no sort param) returns results ordered by `installCount` descending
- [ ] `GET /store?page=2&limit=5` returns the second page of 5 results with correct pagination metadata
- [ ] `limit` is capped at 100; values above 100 are rejected with 400
- [ ] `page` must be >= 1; values below 1 are rejected with 400
- [ ] Recipes with status other than "published" are never returned
- [ ] Each recipe in the response includes `author: { id, name }`
- [ ] No auth token is required to access this endpoint
- [ ] Invalid `category` values return 400
- [ ] Invalid `sort` values return 400

---

## WHI-23: GET /store/:id -- get recipe details

### Files to create/modify

#### `src/routes/store/schemas.ts` (modify -- add)

```typescript
export const storeRecipeIdParamSchema = z.object({
  id: z.string().uuid(),
});
```

#### `src/services/store/index.ts` (modify -- add method)

```typescript
async getById(id: string): Promise<StoreRecipeDetail | null> {
  const [recipe] = await db
    .select({
      id: storeRecipes.id,
      originalRecipeId: storeRecipes.originalRecipeId,
      name: storeRecipes.name,
      description: storeRecipes.description,
      steps: storeRecipes.steps,
      category: storeRecipes.category,
      tags: storeRecipes.tags,
      version: storeRecipes.version,
      installCount: storeRecipes.installCount,
      rating: storeRecipes.rating,
      ratingCount: storeRecipes.ratingCount,
      status: storeRecipes.status,
      publishedAt: storeRecipes.publishedAt,
      updatedAt: storeRecipes.updatedAt,
      authorId: users.id,
      authorName: users.name,
    })
    .from(storeRecipes)
    .innerJoin(users, eq(storeRecipes.authorId, users.id))
    .where(
      and(
        eq(storeRecipes.id, id),
        eq(storeRecipes.status, "published")
      )
    )
    .limit(1);

  if (!recipe) return null;

  const reviews = await db
    .select({
      id: storeReviews.id,
      rating: storeReviews.rating,
      comment: storeReviews.comment,
      createdAt: storeReviews.createdAt,
      userId: users.id,
      userName: users.name,
    })
    .from(storeReviews)
    .innerJoin(users, eq(storeReviews.userId, users.id))
    .where(eq(storeReviews.storeRecipeId, id))
    .orderBy(desc(storeReviews.createdAt))
    .limit(10);

  return {
    id: recipe.id,
    originalRecipeId: recipe.originalRecipeId,
    name: recipe.name,
    description: recipe.description,
    steps: recipe.steps,
    category: recipe.category,
    tags: recipe.tags as string[],
    version: recipe.version,
    installCount: recipe.installCount,
    rating: Number(recipe.rating),
    ratingCount: recipe.ratingCount,
    publishedAt: recipe.publishedAt,
    updatedAt: recipe.updatedAt,
    author: { id: recipe.authorId, name: recipe.authorName },
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      user: { id: r.userId, name: r.userName },
    })),
  };
}
```

**Key interface:**

```typescript
interface StoreRecipeDetail {
  id: string;
  originalRecipeId: string | null;
  name: string;
  description: string;
  steps: unknown; // JSONB -- the recipe step structure from Phase 4
  category: string;
  tags: string[];
  version: number;
  installCount: number;
  rating: number;
  ratingCount: number;
  publishedAt: Date;
  updatedAt: Date;
  author: { id: string; name: string };
  reviews: StoreRecipeReviewItem[];
}

interface StoreRecipeReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  user: { id: string; name: string };
}
```

#### `src/routes/store/index.ts` (modify -- add route)

```typescript
fastify.get("/store/:id", async (request, reply) => {
  const { id } = storeRecipeIdParamSchema.parse(request.params);
  const recipe = await storeService.getById(id);

  if (!recipe) {
    return reply.status(404).send({ error: "Recipe not found" });
  }

  return reply.send({ data: recipe });
});
```

### Dependencies

- `src/db/schema/store-recipes.ts` (WHI-20)
- `src/db/schema/store-reviews.ts` (WHI-20)
- `src/db/schema/users.ts` (existing)

### How it connects to existing pieces

- Public endpoint, same as the browse route
- Reuses the `users` join for both the author and the review authors
- Returns the full `steps` JSONB payload, which follows the same structure defined in Phase 4's recipe schema
- The reviews sub-query runs in parallel with the main query via `Promise.all` or sequentially after recipe fetch (sequential shown above since we need to confirm the recipe exists before querying reviews)

### Acceptance criteria

- [ ] `GET /store/:id` with a valid published recipe ID returns 200 with full recipe details
- [ ] Response includes `steps` (the full JSONB content)
- [ ] Response includes `author: { id, name }`
- [ ] Response includes `reviews` array with up to 10 most recent reviews
- [ ] Each review includes `user: { id, name }`, `rating`, `comment`, `createdAt`
- [ ] `GET /store/:id` with a non-existent UUID returns 404
- [ ] `GET /store/:id` with a recipe that has status "unpublished", "flagged", or "removed" returns 404
- [ ] `GET /store/:id` with an invalid (non-UUID) ID returns 400
- [ ] No auth token is required

---

## WHI-25: POST /store/publish -- publish user recipe

### Files to create/modify

#### `src/routes/store/schemas.ts` (modify -- add)

```typescript
export const publishRecipeBodySchema = z.object({
  recipeId: z.string().uuid(),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(2000),
  category: z.enum(STORE_RECIPE_CATEGORIES),
  tags: z
    .array(z.string().min(1).max(50))
    .max(10)
    .optional()
    .default([]),
});

export type PublishRecipeBody = z.infer<typeof publishRecipeBodySchema>;
```

#### `src/services/store/index.ts` (modify -- add method)

```typescript
async publish(
  userId: string,
  body: PublishRecipeBody
): Promise<StoreRecipe> {
  const [recipe] = await db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.id, body.recipeId),
        eq(recipes.userId, userId)
      )
    )
    .limit(1);

  if (!recipe) {
    throw new AppError(404, "Recipe not found or not owned by you");
  }

  const [existing] = await db
    .select()
    .from(storeRecipes)
    .where(
      and(
        eq(storeRecipes.originalRecipeId, body.recipeId),
        eq(storeRecipes.authorId, userId)
      )
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(storeRecipes)
      .set({
        name: recipe.name,
        description: body.description,
        steps: recipe.steps,
        category: body.category,
        tags: body.tags,
        version: existing.version + 1,
        status: "published",
        updatedAt: new Date(),
      })
      .where(eq(storeRecipes.id, existing.id))
      .returning();

    return updated;
  }

  const [published] = await db
    .insert(storeRecipes)
    .values({
      originalRecipeId: body.recipeId,
      authorId: userId,
      name: recipe.name,
      description: body.description,
      steps: recipe.steps,
      category: body.category,
      tags: body.tags,
    })
    .returning();

  return published;
}
```

**Key behaviors:**

1. **Ownership check:** Verify the `recipeId` belongs to the authenticated user by querying `recipes` where `id = recipeId AND userId = authenticatedUserId`.
2. **Step snapshot:** Copy `recipe.steps` into the store recipe. The store recipe is now independent -- edits to the personal recipe do not propagate.
3. **Re-publish (version bump):** If a `store_recipes` row already exists with the same `originalRecipeId + authorId`, update it: re-snapshot the steps, update description/category/tags, increment `version`, set status back to "published" (in case it was unpublished).
4. **Name inheritance:** The store recipe name is taken from the personal recipe's current name at publish time.

#### `src/routes/store/index.ts` (modify -- add route)

```typescript
fastify.post(
  "/store/publish",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const body = publishRecipeBodySchema.parse(request.body);
    const userId = request.user.id;

    const published = await storeService.publish(userId, body);

    return reply.status(201).send({ data: published });
  }
);
```

**Auth integration:** This route uses the `fastify.authenticate` preHandler from Phase 3. The `request.user` object is populated by the auth middleware and contains at minimum `{ id: string }`.

### Dependencies

- `src/db/schema/store-recipes.ts` (WHI-20)
- `src/db/schema/recipes.ts` (existing -- Phase 4)
- `src/middleware/auth.ts` or equivalent (existing -- Phase 3)
- `src/lib/errors.ts` or equivalent `AppError` class (existing)

### How it connects to existing pieces

- Reads from the `recipes` table (Phase 4) to fetch the recipe being published
- Writes to the `store_recipes` table (WHI-20)
- Uses the auth middleware from Phase 3 to identify the publishing user
- The recipe's `steps` JSONB structure is the same one defined in Phase 4 -- no transformation needed

### Acceptance criteria

- [ ] `POST /store/publish` without auth returns 401
- [ ] `POST /store/publish` with a `recipeId` not owned by the user returns 404
- [ ] `POST /store/publish` with a valid owned recipe returns 201 with the published store recipe
- [ ] The published recipe's `steps` are a snapshot of the personal recipe's steps at the time of publishing
- [ ] The published recipe's `name` matches the personal recipe's current name
- [ ] The `description` comes from the request body, not from the personal recipe
- [ ] The `category` is validated against the allowed list; invalid values return 400
- [ ] `tags` defaults to `[]` if not provided
- [ ] `tags` is validated: max 10 tags, each tag 1--50 characters
- [ ] `description` is validated: min 10 characters, max 2000 characters
- [ ] Re-publishing the same recipe increments `version` by 1
- [ ] Re-publishing updates `steps`, `description`, `category`, `tags`, and `updatedAt`
- [ ] Re-publishing an unpublished recipe sets status back to "published"
- [ ] The response includes all store recipe fields including `id`, `version`, `publishedAt`
- [ ] Editing the personal recipe after publishing does NOT change the published store recipe's steps

---

## WHI-26: POST /store/:id/install -- install recipe to user

### Files to create/modify

#### `src/routes/store/schemas.ts` (modify -- add)

```typescript
export const installRecipeParamSchema = z.object({
  id: z.string().uuid(),
});
```

(This is the same shape as `storeRecipeIdParamSchema` -- can reuse it, or keep separate for clarity.)

#### `src/services/store/index.ts` (modify -- add method)

```typescript
async install(
  storeRecipeId: string,
  userId: string
): Promise<Recipe> {
  const [storeRecipe] = await db
    .select()
    .from(storeRecipes)
    .where(
      and(
        eq(storeRecipes.id, storeRecipeId),
        eq(storeRecipes.status, "published")
      )
    )
    .limit(1);

  if (!storeRecipe) {
    throw new AppError(404, "Store recipe not found");
  }

  const result = await db.transaction(async (tx) => {
    const [newRecipe] = await tx
      .insert(recipes)
      .values({
        userId,
        name: storeRecipe.name,
        steps: storeRecipe.steps,
        installedFromStoreId: storeRecipe.id,
      })
      .returning();

    await tx
      .update(storeRecipes)
      .set({
        installCount: sql`${storeRecipes.installCount} + 1`,
      })
      .where(eq(storeRecipes.id, storeRecipeId));

    return newRecipe;
  });

  return result;
}
```

**Key behaviors:**

1. **Fetch store recipe:** Verify it exists and has status "published".
2. **Transaction:** Both the insert and the counter increment must succeed or fail together.
3. **Copy to personal recipes:** Create a new row in the `recipes` table with:
   - `userId`: the authenticated user
   - `name`: the store recipe's name
   - `steps`: the store recipe's steps (copied, not referenced)
   - `installedFromStoreId`: the store recipe's ID (for tracking provenance)
4. **Increment install count:** Use `sql` expression to atomically increment to avoid race conditions.
5. **Duplicate installs:** Allowed. Each install creates a new personal recipe copy. The user can install the same store recipe multiple times. This is intentional -- the user might want multiple copies to customize differently.

#### `src/routes/store/index.ts` (modify -- add route)

```typescript
fastify.post(
  "/store/:id/install",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { id } = installRecipeParamSchema.parse(request.params);
    const userId = request.user.id;

    const newRecipe = await storeService.install(id, userId);

    return reply.status(201).send({ data: newRecipe });
  }
);
```

### Dependencies

- `src/db/schema/store-recipes.ts` (WHI-20)
- `src/db/schema/recipes.ts` (existing -- Phase 4, modified in WHI-20 to add `installedFromStoreId`)
- `src/middleware/auth.ts` or equivalent (existing -- Phase 3)
- `drizzle-orm` transactions

### How it connects to existing pieces

- Creates a new row in the existing `recipes` table (Phase 4), so the installed recipe is immediately available through all existing recipe CRUD endpoints
- The `installedFromStoreId` column added in WHI-20 links the new personal recipe back to the store
- Uses the same auth middleware from Phase 3
- The installed recipe can be executed through the existing recipe execution endpoints (Phase 5) without any changes

### Acceptance criteria

- [ ] `POST /store/:id/install` without auth returns 401
- [ ] `POST /store/:id/install` with a non-existent store recipe ID returns 404
- [ ] `POST /store/:id/install` with an unpublished store recipe returns 404
- [ ] `POST /store/:id/install` with a valid published recipe returns 201 with the new personal recipe
- [ ] The new personal recipe has `name` matching the store recipe's name
- [ ] The new personal recipe has `steps` matching the store recipe's steps
- [ ] The new personal recipe has `installedFromStoreId` set to the store recipe's ID
- [ ] The new personal recipe has `userId` set to the authenticated user
- [ ] The store recipe's `installCount` is incremented by 1
- [ ] The increment is atomic (safe under concurrent requests)
- [ ] Installing the same recipe twice creates two separate personal recipes (no duplicate prevention)
- [ ] The new personal recipe appears in the user's `GET /recipes` list (existing Phase 4 endpoint)
- [ ] The new personal recipe can be executed via `POST /recipes/:id/execute` (existing Phase 5 endpoint)
- [ ] The transaction rolls back if either the insert or the increment fails

---

## Shared infrastructure

### Complete file inventory

| File | Action | Issue |
|---|---|---|
| `src/db/schema/store-recipes.ts` | Create | WHI-20 |
| `src/db/schema/store-reviews.ts` | Create | WHI-20 |
| `src/db/schema/index.ts` | Modify (add exports) | WHI-20 |
| `src/db/schema/recipes.ts` | Modify (add `installedFromStoreId` column) | WHI-20 |
| `src/db/migrations/XXXX_add_store_tables.ts` | Create (generated) | WHI-20 |
| `src/services/store/index.ts` | Create | WHI-13, WHI-23, WHI-25, WHI-26 |
| `src/routes/store/index.ts` | Create | WHI-13, WHI-23, WHI-25, WHI-26 |
| `src/routes/store/schemas.ts` | Create | WHI-13, WHI-23, WHI-25, WHI-26 |
| `src/app.ts` or `src/server.ts` | Modify (register store routes) | All |

### `src/services/store/index.ts` -- full class outline

```typescript
export class StoreService {
  async browse(query: BrowseStoreQuery): Promise<BrowseStoreResponse>
  async getById(id: string): Promise<StoreRecipeDetail | null>
  async publish(userId: string, body: PublishRecipeBody): Promise<StoreRecipe>
  async install(storeRecipeId: string, userId: string): Promise<Recipe>
}
```

All methods are stateless; the class holds no instance state and can be instantiated once at route registration time.

### `src/routes/store/index.ts` -- full route table

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/store` | None (public) | `storeService.browse(query)` |
| GET | `/store/:id` | None (public) | `storeService.getById(id)` |
| POST | `/store/publish` | Required | `storeService.publish(userId, body)` |
| POST | `/store/:id/install` | Required | `storeService.install(id, userId)` |

### `src/routes/store/schemas.ts` -- full schema inventory

| Export | Type | Used by |
|---|---|---|
| `browseStoreQuerySchema` | Zod object | WHI-13 |
| `storeRecipeIdParamSchema` | Zod object | WHI-23, WHI-26 |
| `publishRecipeBodySchema` | Zod object | WHI-25 |
| `installRecipeParamSchema` | Zod object | WHI-26 (or reuse `storeRecipeIdParamSchema`) |
| `BrowseStoreQuery` | TypeScript type (inferred) | WHI-13 |
| `PublishRecipeBody` | TypeScript type (inferred) | WHI-25 |

### Error handling

All service methods should throw `AppError` (or the project's existing error class from earlier phases) for expected failures. The existing Fastify error handler will catch these and return the appropriate HTTP status code and error message.

| Scenario | HTTP Status | Error Message |
|---|---|---|
| Recipe not found (GET detail) | 404 | "Recipe not found" |
| Recipe not owned (publish) | 404 | "Recipe not found or not owned by you" |
| Store recipe not found (install) | 404 | "Store recipe not found" |
| Validation error (any) | 400 | Zod error details |
| Unauthorized (publish, install) | 401 | "Unauthorized" (from auth middleware) |

### Types file (optional but recommended)

#### `src/services/store/types.ts`

```typescript
export interface StoreRecipeListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  installCount: number;
  rating: number;
  ratingCount: number;
  publishedAt: Date;
  author: { id: string; name: string };
}

export interface BrowseStoreResponse {
  data: StoreRecipeListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface StoreRecipeReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  user: { id: string; name: string };
}

export interface StoreRecipeDetail {
  id: string;
  originalRecipeId: string | null;
  name: string;
  description: string;
  steps: unknown;
  category: string;
  tags: string[];
  version: number;
  installCount: number;
  rating: number;
  ratingCount: number;
  publishedAt: Date;
  updatedAt: Date;
  author: { id: string; name: string };
  reviews: StoreRecipeReviewItem[];
}
```

---

## Migration and rollback strategy

### Forward migration

1. Run `npx drizzle-kit generate` to produce the migration SQL from the schema changes.
2. Review the generated SQL to confirm:
   - Both tables are created with correct column types
   - All indexes are present, including the GIN index on `tags`
   - The `recipes` table alteration adds `installed_from_store_id`
   - Foreign keys and cascade/set-null rules are correct
3. Run `npx drizzle-kit migrate` to apply.

### Rollback migration

If rollback is needed:

```sql
ALTER TABLE recipes DROP COLUMN IF EXISTS installed_from_store_id;
DROP TABLE IF EXISTS store_reviews;
DROP TABLE IF EXISTS store_recipes;
```

Order matters: `store_reviews` references `store_recipes`, so it must be dropped first. The `recipes` column must be dropped before `store_recipes` because of the FK.

### Implementation order

The recommended implementation order within Phase 6:

1. **WHI-20** -- Schema and migration (all other issues depend on this)
2. **WHI-25** -- Publish endpoint (needed to populate store with data for testing browse/detail)
3. **WHI-13** -- Browse endpoint (can now test with published recipes)
4. **WHI-23** -- Detail endpoint (builds on browse; shares service patterns)
5. **WHI-26** -- Install endpoint (needs published recipes to install; tests the full loop)

### Testing strategy

Each issue should include:

- **Unit tests** for the service methods (mock the database layer)
- **Integration tests** that hit the actual endpoints with a test database
- **Test fixtures:** Create helper functions to seed `users`, `recipes`, `store_recipes`, and `store_reviews` for consistent test data

Suggested test file locations:

- `src/services/store/__tests__/store.service.test.ts`
- `src/routes/store/__tests__/store.routes.test.ts`

---

## Appendix: future considerations (out of scope for Phase 6)

These items are explicitly NOT part of Phase 6 but are worth noting for architectural decisions made here:

- **Full-text search upgrade:** The current `ILIKE` search is acceptable for initial launch but should be upgraded to PostgreSQL `tsvector` with a GIN index if the store grows to thousands of recipes.
- **Review CRUD endpoints:** Phase 6 defines the `store_reviews` schema but does not include endpoints for creating/updating/deleting reviews. These would be a natural Phase 7 addition.
- **Rate limiting on install:** The atomic increment is safe under concurrency, but rate limiting should be considered to prevent abuse.
- **Pagination for reviews:** The detail endpoint returns the 10 most recent reviews. A paginated reviews endpoint may be needed as review volume grows.
- **Store recipe versioning history:** Currently only the latest version is stored. A version history table could track all published versions.
- **Unpublish endpoint:** Authors should be able to set their recipe status to "unpublished". This could be a simple `PATCH /store/:id` or `DELETE /store/:id` endpoint.
