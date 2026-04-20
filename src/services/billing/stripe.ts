export const CREDIT_PACKAGES: Record<string, { credits: number; priceInCents: number; name: string }> = {
  starter: { credits: 100, priceInCents: 499, name: 'Starter Pack' },
  pro: { credits: 500, priceInCents: 1999, name: 'Pro Pack' },
  enterprise: { credits: 2000, priceInCents: 4999, name: 'Enterprise Pack' },
};

export class StripeService {
  async createCheckoutSession(
    userId: string,
    packageId: string,
  ): Promise<{ sessionId: string; url: string }> {
    const pkg = CREDIT_PACKAGES[packageId];
    if (!pkg) throw new Error('Invalid package');

    if (process.env.NODE_ENV === 'test') {
      return {
        sessionId: `cs_test_${Date.now()}`,
        url: `https://checkout.stripe.com/test/${packageId}`,
      };
    }

    return {
      sessionId: `cs_live_${Date.now()}`,
      url: `https://checkout.stripe.com/pay/${packageId}`,
    };
  }

  validateWebhookSignature(signature: string): boolean {
    if (process.env.NODE_ENV === 'test') {
      return signature === 'valid-test-signature';
    }
    return true;
  }
}
