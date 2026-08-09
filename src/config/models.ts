import { z } from 'zod';

/**
 * Model used by seeded recipes and /polish when nothing is configured. Kept as
 * the historical default so behaviour is unchanged without env configuration.
 */
export const FALLBACK_MODEL = 'gpt-4o-mini';

const modelIdSchema = z.string().trim().min(1);

function readModelEnv(name: string): string | null {
  const parsed = modelIdSchema.safeParse(process.env[name]);
  return parsed.success ? parsed.data : null;
}

/** The DEFAULT_RECIPE_MODEL override, or null when it is not configured. */
export function configuredRecipeModel(): string | null {
  return readModelEnv('DEFAULT_RECIPE_MODEL');
}

/** Model baked into the default recipes seeded for every new user. */
export function defaultRecipeModel(): string {
  return configuredRecipeModel() ?? FALLBACK_MODEL;
}

/** Model used by POST /polish; falls back to the seeded recipe model. */
export function polishModel(): string {
  return readModelEnv('POLISH_MODEL') ?? defaultRecipeModel();
}
