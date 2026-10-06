import { eq, and, sql, ilike, or, desc } from 'drizzle-orm';
import { storeRecipes } from '../../db/schema/store-recipes.js';
import { storeReviews } from '../../db/schema/store-reviews.js';
import { recipes } from '../../db/schema/recipes.js';
import type { RecipeStep } from '../../db/schema/recipes.js';
import { users } from '../../db/schema/users.js';
import type { Database } from '../../db/index.js';

export class StoreService {
  constructor(private db: Database) {}

  async browse(opts: {
    page: number;
    limit: number;
    category?: string;
    search?: string;
    tags?: string[];
    sort?: string;
  }) {
    const { page, limit, category, search, tags, sort } = opts;
    const offset = (page - 1) * limit;

    const conditions: ReturnType<typeof eq>[] = [
      eq(storeRecipes.status, 'published'),
    ];

    if (category) {
      conditions.push(eq(storeRecipes.category, category));
    }

    if (search) {
      conditions.push(
        or(
          ilike(storeRecipes.name, `%${search}%`),
          ilike(storeRecipes.description, `%${search}%`),
        )!,
      );
    }

    const where = and(...conditions);

    let orderBy;
    switch (sort) {
      case 'newest':
        orderBy = desc(storeRecipes.publishedAt);
        break;
      case 'top-rated':
        orderBy = desc(storeRecipes.rating);
        break;
      case 'popular':
      default:
        orderBy = desc(storeRecipes.installCount);
        break;
    }

    const [data, countResult] = await Promise.all([
      this.db
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
          authorId: storeRecipes.authorId,
          authorName: users.name,
        })
        .from(storeRecipes)
        .leftJoin(users, eq(storeRecipes.authorId, users.id))
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(orderBy),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(storeRecipes)
        .where(where),
    ]);

    let filteredData = data;
    if (tags && tags.length > 0) {
      filteredData = data.filter((r) => {
        const recipeTags = r.tags as string[];
        return tags.every((t) => recipeTags.includes(t));
      });
    }

    const formattedData = filteredData.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      tags: r.tags,
      installCount: r.installCount,
      rating: r.rating,
      ratingCount: r.ratingCount,
      publishedAt: r.publishedAt,
      author: {
        id: r.authorId,
        name: r.authorName ?? 'Unknown',
      },
    }));

    const total = tags && tags.length > 0 ? formattedData.length : countResult[0].count;
    const totalPages = Math.ceil(total / limit);

    return {
      data: formattedData,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async getById(id: string) {
    const [recipeResult, reviews] = await Promise.all([
      this.db
        .select({
          id: storeRecipes.id,
          name: storeRecipes.name,
          description: storeRecipes.description,
          category: storeRecipes.category,
          tags: storeRecipes.tags,
          steps: storeRecipes.steps,
          installCount: storeRecipes.installCount,
          rating: storeRecipes.rating,
          ratingCount: storeRecipes.ratingCount,
          status: storeRecipes.status,
          version: storeRecipes.version,
          publishedAt: storeRecipes.publishedAt,
          authorId: storeRecipes.authorId,
          authorName: users.name,
        })
        .from(storeRecipes)
        .leftJoin(users, eq(storeRecipes.authorId, users.id))
        .where(and(eq(storeRecipes.id, id), eq(storeRecipes.status, 'published')))
        .limit(1),
      this.db
        .select({
          id: storeReviews.id,
          rating: storeReviews.rating,
          comment: storeReviews.comment,
          createdAt: storeReviews.createdAt,
          userId: storeReviews.userId,
          userName: users.name,
        })
        .from(storeReviews)
        .leftJoin(users, eq(storeReviews.userId, users.id))
        .where(eq(storeReviews.storeRecipeId, id))
        .orderBy(desc(storeReviews.createdAt))
        .limit(10),
    ]);

    const recipe = recipeResult[0];
    if (!recipe) return null;

    return {
      ...recipe,
      author: {
        id: recipe.authorId,
        name: recipe.authorName ?? 'Unknown',
      },
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        user: {
          id: r.userId,
          name: r.userName ?? 'Unknown',
        },
      })),
    };
  }

  async publish(
    userId: string,
    recipeId: string,
    data: {
      description: string;
      category: string;
      tags?: string[];
    },
  ) {
    const [recipe] = await this.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
      .limit(1);

    if (!recipe) return null;

    const [existing] = await this.db
      .select()
      .from(storeRecipes)
      .where(eq(storeRecipes.originalRecipeId, recipeId))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(storeRecipes)
        .set({
          name: recipe.name,
          description: data.description,
          category: data.category,
          tags: data.tags ?? [],
          steps: recipe.steps as Array<{ type: string; config: Record<string, unknown> }>,
          version: existing.version + 1,
          status: 'published',
        })
        .where(eq(storeRecipes.id, existing.id))
        .returning();

      return updated;
    }

    const [published] = await this.db
      .insert(storeRecipes)
      .values({
        originalRecipeId: recipeId,
        authorId: userId,
        name: recipe.name,
        description: data.description,
        category: data.category,
        tags: data.tags ?? [],
        steps: recipe.steps as Array<{ type: string; config: Record<string, unknown> }>,
      })
      .returning();

    return published;
  }

  async install(storeRecipeId: string, userId: string) {
    const [storeRecipe] = await this.db
      .select()
      .from(storeRecipes)
      .where(and(eq(storeRecipes.id, storeRecipeId), eq(storeRecipes.status, 'published')))
      .limit(1);

    if (!storeRecipe) return null;

    const [newRecipe] = await this.db
      .insert(recipes)
      .values({
        userId,
        name: storeRecipe.name,
        steps: storeRecipe.steps as unknown as RecipeStep[],
        installedFromStoreId: storeRecipeId,
      })
      .returning();

    await this.db
      .update(storeRecipes)
      .set({
        installCount: sql`${storeRecipes.installCount} + 1`,
      })
      .where(eq(storeRecipes.id, storeRecipeId));

    return newRecipe;
  }

  async addReview(
    storeRecipeId: string,
    userId: string,
    rating: number,
    comment?: string,
  ) {
    const [review] = await this.db
      .insert(storeReviews)
      .values({
        storeRecipeId,
        userId,
        rating,
        comment: comment ?? null,
      })
      .returning();

    const [stats] = await this.db
      .select({
        avgRating: sql<number>`ROUND(AVG(rating))::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(storeReviews)
      .where(eq(storeReviews.storeRecipeId, storeRecipeId));

    await this.db
      .update(storeRecipes)
      .set({
        rating: stats.avgRating,
        ratingCount: stats.count,
      })
      .where(eq(storeRecipes.id, storeRecipeId));

    return review;
  }
}
