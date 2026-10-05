import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { ROLES, ROLE_LABELS, hasPermission } from "../../lib/permissions.js";
import { errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";
import { ASSIGNABLE_ROLES, OWNER_MANAGED_ROLES } from "../staff/staff.schemas.js";
import { REFERENCE } from "./labels.js";

const OptionList = Type.Array(Type.Object({ value: Type.String(), label: Type.String() }));

/** Vocabularies and caller-specific choices for building forms. */
const referenceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize(),
      config: { allowPasswordChangeRequired: true },
      schema: {
        tags: ["reference"],
        summary: "Labels and allowed values for forms, including the roles the caller may assign",
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            roles: OptionList,
            assignableRoles: OptionList,
            roomStatuses: OptionList,
            reservationStatuses: OptionList,
            paymentStatuses: OptionList,
            paymentMethods: OptionList,
            staffPaymentMethods: OptionList,
            posPaymentMethods: OptionList,
            employmentStatuses: OptionList,
            stockMovements: OptionList,
            paymentProviders: OptionList,
            exceptionKinds: OptionList,
          }),
          ...errorResponses(401),
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const assignable = hasPermission(principal.role, "staff:write")
        ? ASSIGNABLE_ROLES.filter((role) => principal.role === "owner" || !OWNER_MANAGED_ROLES.has(role))
        : [];
      reply.header("cache-control", "private, max-age=300");
      return {
        ...REFERENCE,
        roles: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
        assignableRoles: assignable.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
      };
    },
  );
};

export default referenceRoutes;
