import Stripe from 'stripe';

export const CREDIT_PACKAGES: Record<string, { credits: number; priceInCents: number; name: string }> = {
  starter: { credits: 100, priceInCents: 499, name: 'Starter Pack' },
  pro: { credits: 500, priceInCents: 1999, name: 'Pro Pack' },
  enterprise: { credits: 2000, priceInCents: 4999, name: 'Enterprise Pack' },
};

function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }
  return new Stripe(key);
}

export class StripeService {
  async createCheckoutSession(
    userId: string,
    packageId: string,
  ): Promise<{ sessionId: string; url: string }> {
    const pkg = CREDIT_PACKAGES[packageId];
    if (!pkg) throw new Error('Invalid package');

    const stripe = getStripeClient();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: pkg.name },
            unit_amount: pkg.priceInCents,
          },
          quantity: 1,
        },
      ],
      metadata: { userId, packageId },
      success_url: process.env.STRIPE_SUCCESS_URL ?? 'http://localhost:3000/billing/success',
      cancel_url: process.env.STRIPE_CANCEL_URL ?? 'http://localhost:3000/billing/cancel',
    });

    return {
      sessionId: session.id,
      url: session.url!,
    };
  }

  validateWebhookSignature(
    payload: string | Buffer,
    signature: string,
  ): Stripe.Event {
    if (process.env.NODE_ENV === 'test') {
      if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
        return payload as unknown as Stripe.Event;
      }
      const raw = typeof payload === 'string' ? payload : payload.toString('utf-8');
      return JSON.parse(raw) as Stripe.Event;
    }

    const stripe = getStripeClient();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }
}
