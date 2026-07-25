import { z } from 'zod';

/**
 * Env-gated escape hatch for staging / end-to-end testing.
 *
 * When `BILLING_BYPASS` is truthy every request is treated as a fully paid
 * subscriber with unlimited credits: balance checks succeed, deductions become
 * no-ops, and the platform LLM key falls back to a placeholder so requests can
 * reach an OpenAI-compatible proxy that does not require auth.
 *
 * The flag defaults to OFF, so production behaviour is unchanged when the
 * variable is absent. The underlying billing logic is bypassed, never removed.
 */
const TRUTHY_VALUES: readonly string[] = ['1', 'true', 'yes', 'on'];

const bypassFlagSchema = z.string();

/** Balance reported to clients while the bypass is active. */
export const BYPASS_CREDIT_BALANCE = 999_999_999;

/** Subscription snapshot reported to clients while the bypass is active. */
export const BYPASS_SUBSCRIPTION = {
  status: 'active',
  plan: 'unlimited',
  source: 'billing-bypass',
} as const;

/**
 * Placeholder key used when no platform key is configured. Auth-free proxies
 * ignore it; it only exists so the provider SDKs have a non-empty bearer token.
 */
export const BYPASS_PLACEHOLDER_API_KEY = 'billing-bypass-no-auth-required';

export function isBillingBypassEnabled(): boolean {
  const parsed = bypassFlagSchema.safeParse(process.env.BILLING_BYPASS);
  if (!parsed.success) return false;
  return TRUTHY_VALUES.includes(parsed.data.trim().toLowerCase());
}

/**
 * Returns the configured platform key, or the bypass placeholder when the
 * bypass is on and no key is configured. Returns null when the bypass is off.
 */
export function resolvePlatformApiKey(configuredKey: string | undefined | null): string | null {
  if (configuredKey) return configuredKey;
  return isBillingBypassEnabled() ? BYPASS_PLACEHOLDER_API_KEY : null;
}
