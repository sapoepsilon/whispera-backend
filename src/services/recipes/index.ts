import { eq, and, isNull, ilike, sql } from 'drizzle-orm';
import { recipes } from '../../db/schema/recipes.js';
import type { NewRecipe } from '../../db/schema/recipes.js';
import type { Database } from '../../db/index.js';

export class RecipeService {
  constructor(private db: Database) {}

  async create(data: NewRecipe) {
    const [recipe] = await this.db.insert(recipes).values(data).returning();
    return recipe;
  }

  async listByUser(
    userId: string,
    opts: { page: number; limit: number; search?: string },
  ) {
    const { page, limit, search } = opts;
    const offset = (page - 1) * limit;

    const conditions = [eq(recipes.userId, userId), isNull(recipes.deletedAt)];
    if (search) {
      conditions.push(ilike(recipes.name, `%${search}%`));
    }

    const where = and(...conditions);

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(recipes)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(recipes.createdAt),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(recipes)
        .where(where),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total: countResult[0].count,
      },
    };
  }

  async findByIdAndUser(id: string, userId: string) {
    const [recipe] = await this.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.userId, userId), isNull(recipes.deletedAt)))
      .limit(1);
    return recipe ?? null;
  }

  async update(id: string, userId: string, data: Partial<Omit<NewRecipe, 'id' | 'userId' | 'createdAt'>>) {
    const existing = await this.findByIdAndUser(id, userId);
    if (!existing) return null;

    const [updated] = await this.db
      .update(recipes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(recipes.id, id))
      .returning();

    return updated;
  }

  async softDelete(id: string, userId: string) {
    const existing = await this.findByIdAndUser(id, userId);
    if (!existing) return null;

    const [deleted] = await this.db
      .update(recipes)
      .set({ deletedAt: new Date() })
      .where(eq(recipes.id, id))
      .returning();

    return deleted;
  }
}
