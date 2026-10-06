import { eq, and, sql, desc } from 'drizzle-orm';
import { executions } from '../db/schema/executions.js';
import type { NewExecution } from '../db/schema/executions.js';
import type { Database } from '../db/index.js';

export class ExecutionService {
  constructor(private db: Database) {}

  async save(data: NewExecution) {
    const [result] = await this.db
      .insert(executions)
      .values(data)
      .onConflictDoUpdate({
        target: executions.id,
        set: {
          status: data.status,
          steps: data.steps,
          variables: data.variables,
          metadata: data.metadata,
          error: data.error,
          completedAt: data.completedAt,
        },
      })
      .returning();
    return result;
  }

  async listByRecipe(
    recipeId: string,
    userId: string,
    opts: { page: number; limit: number },
  ) {
    const { page, limit } = opts;
    const offset = (page - 1) * limit;

    const where = and(
      eq(executions.recipeId, recipeId),
      eq(executions.userId, userId),
    );

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(executions)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(executions.startedAt)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(executions)
        .where(where),
    ]);

    const total = countResult[0].count;

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getByIdAndUserId(id: string, userId: string) {
    const [execution] = await this.db
      .select()
      .from(executions)
      .where(and(eq(executions.id, id), eq(executions.userId, userId)))
      .limit(1);
    return execution ?? null;
  }
}
