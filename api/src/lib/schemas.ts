import { Type, type Static } from "typebox";

/** Standard error envelope returned by every non-2xx response. */
export const ErrorResponse = Type.Object(
  {
    statusCode: Type.Integer(),
    error: Type.String(),
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    details: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() }))),
  },
  { $id: "ErrorResponse", title: "ErrorResponse" },
);
export type ErrorResponse = Static<typeof ErrorResponse>;

/** Shorthand for documenting the standard error responses of a route. */
export function errorResponses(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, Type.Ref("ErrorResponse")]));
}
