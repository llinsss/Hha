import fp from "fastify-plugin";
import { createPaymentProvider } from "../modules/payments/providers/index.js";

/** Decorates the configured payment provider (null when online payment is disabled). */
export default fp(
  async (app) => {
    const provider = createPaymentProvider(app.config);
    app.decorate("paymentProvider", provider);
    if (!provider) app.log.warn("PAYMENT_PROVIDER is none: public online booking and payment webhooks are disabled");
  },
  { name: "payments" },
);
