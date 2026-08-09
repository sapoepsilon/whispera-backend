import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreditService } from '../../services/billing/credits.js';
import { StripeService, CREDIT_PACKAGES } from '../../services/billing/stripe.js';
import { isBillingBypassEnabled, BYPASS_SUBSCRIPTION } from '../../services/billing/bypass.js';

const purchaseSchema = z.object({
  packageId: z.string().refine((val) => val in CREDIT_PACKAGES, {
    message: 'Invalid package ID',
  }),
});

export default async function billingCreditsRoutes(app: FastifyInstance) {
  const creditService = new CreditService(app.db);
  const stripeService = new StripeService();

  app.get(
    '/billing/credits',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const [balance, transactions] = await Promise.all([
        creditService.getBalance(request.userId),
        creditService.getTransactions(request.userId),
      ]);

      if (isBillingBypassEnabled()) {
        return reply.code(200).send({
          balance,
          transactions,
          unlimited: true,
          subscription: BYPASS_SUBSCRIPTION,
        });
      }

      return reply.code(200).send({ balance, transactions });
    },
  );

  app.post(
    '/billing/credits/purchase',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = purchaseSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const { packageId } = result.data;

      const session = await stripeService.createCheckoutSession(request.userId, packageId);
      return reply.code(200).send(session);
    },
  );

  app.register(async function webhookScope(scope) {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: null, body: Buffer) => void) => {
        done(null, body);
      },
    );

    scope.post(
      '/billing/webhooks/stripe',
      { config: { rateLimit: false } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const signature = request.headers['stripe-signature'] as string;
        if (!signature) {
          return reply.code(400).send({ error: 'Missing stripe-signature header' });
        }

        let event;
        try {
          const rawBody = request.body as Buffer;
          event = stripeService.validateWebhookSignature(rawBody, signature);
        } catch {
          return reply.code(400).send({ error: 'Invalid webhook signature' });
        }

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as {
            id: string;
            metadata: { userId: string; packageId: string } | null;
          };

          const userId = session.metadata?.userId;
          const packageId = session.metadata?.packageId;

          if (userId && packageId) {
            const alreadyProcessed = await creditService.hasProcessedSession(session.id);
            if (!alreadyProcessed) {
              const pkg = CREDIT_PACKAGES[packageId];
              if (pkg) {
                await creditService.addCredits(userId, pkg.credits, session.id);
              }
            }
          }
        }

        return reply.code(200).send({ received: true });
      },
    );
  });
}
