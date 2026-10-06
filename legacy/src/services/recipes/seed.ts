import { and, eq, isNull } from 'drizzle-orm';
import { recipes } from '../../db/schema/recipes.js';
import type { NewRecipe } from '../../db/schema/recipes.js';
import type { Database } from '../../db/index.js';

export const DEFAULT_RECIPES: ReadonlyArray<Omit<NewRecipe, 'userId'>> = [
  {
    name: 'Polish speech',
    description:
      'Default cleanup that runs on every transcription unless a trigger phrase matches. Removes filler words, fixes grammar, preserves meaning and tone.',
    triggerPhrase: null,
    steps: [
      {
        type: 'llm',
        name: 'polish',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Clean up this dictated text. Remove filler words (um, uh, like, you know), fix grammar and punctuation, but preserve the speaker\'s meaning, tone, and voice. Do not make it more formal unless it already was. Output only the cleaned text, no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
  {
    name: 'Make professional',
    description: 'Rewrites the input in a polite, professional tone.',
    triggerPhrase: 'make professional',
    steps: [
      {
        type: 'llm',
        name: 'rewrite',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Rewrite this in a polite, professional tone. Output only the rewritten message, no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
  {
    name: 'Fix grammar',
    description: 'Corrects grammar and punctuation while preserving meaning.',
    triggerPhrase: 'fix grammar',
    steps: [
      {
        type: 'llm',
        name: 'fix',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Fix any grammar and punctuation issues in this text. Preserve the original meaning and tone. Output only the corrected text, no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
  {
    name: 'Summarize',
    description: 'Condenses the input into one sentence.',
    triggerPhrase: 'summarize',
    steps: [
      {
        type: 'llm',
        name: 'summarize',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Summarize this in one sentence. Output only the summary, no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
  {
    name: 'Translate to Spanish',
    description: 'Translates the input to Spanish.',
    triggerPhrase: 'translate to spanish',
    steps: [
      {
        type: 'llm',
        name: 'translate',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Translate this to Spanish. Preserve tone and formatting. Output only the translation, no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
  {
    name: 'Bullet points',
    description: 'Converts a paragraph into bullet points.',
    triggerPhrase: 'bullet points',
    steps: [
      {
        type: 'llm',
        name: 'bulletize',
        config: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt:
            'Convert this text into a clean list of bullet points. Output only the bullets (one per line, each starting with "- "), no preamble.\n\n{{input}}',
        },
      },
    ],
    outputFormat: 'text',
  },
];

export class RecipeSeedService {
  constructor(private db: Database) {}

  async seedDefaultsForUser(userId: string): Promise<{ created: number }> {
    const existing = await this.db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.userId, userId), isNull(recipes.deletedAt)))
      .limit(1);

    if (existing.length > 0) {
      return { created: 0 };
    }

    const rows: NewRecipe[] = DEFAULT_RECIPES.map((r) => ({ ...r, userId }));
    const inserted = await this.db
      .insert(recipes)
      .values(rows)
      .returning({ id: recipes.id });
    return { created: inserted.length };
  }
}
