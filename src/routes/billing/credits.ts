import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreditService } from '../../services/billing/credits.js';
import { StripeService, CREDIT_PACKAGES } from '../../services/billing/stripe.js';

const purchaseSchema = z.object({
  packageId: z.string().refine((val) => val in CREDIT_PACKAGES, {
    message: 'Invalid package ID',
  }),
});

export default async function billingCreditsRoutes(app: FastifyInstance) {
  const creditService = new CreditService();
  const stripeService = new StripeService();

  app.get(
    '/billing/credits',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const balance = await creditService.getBalance(request.userId);
      const transactions = await creditService.getTransactions(request.userId);

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

  app.post(
    '/billing/webhooks/stripe',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['stripe-signature'] as string;

      if (!stripeService.validateWebhookSignature(signature)) {
        return reply.code(400).send({ error: 'Invalid webhook signature' });
      }

      const body = request.body as {
        type: string;
        data: {
          object: {
            id: string;
            metadata: {
              userId: string;
              packageId: string;
            };
          };
        };
      };

      if (body.type === 'checkout.session.completed') {
        const { id: sessionId, metadata } = body.data.object;
        const { userId, packageId } = metadata;

        const alreadyProcessed = await creditService.hasProcessedSession(sessionId);
        if (!alreadyProcessed) {
          const pkg = CREDIT_PACKAGES[packageId];
          if (pkg) {
            await creditService.addCredits(userId, pkg.credits, sessionId);
          }
        }
      }

      return reply.code(200).send({ received: true });
    },
  );
}
