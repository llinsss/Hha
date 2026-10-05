import { Type } from "typebox";
import { errorResponses } from "../../lib/schemas.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../../lib/password.js";
import { ROLES, type Role } from "../../lib/permissions.js";

const SessionUser = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    fullName: Type.String(),
    role: Type.Unsafe<Role>({ type: "string", enum: [...ROLES] }),
    propertyId: Type.String({ format: "uuid" }),
    mustChangePassword: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TokenResponse = Type.Object(
  {
    accessToken: Type.String(),
    tokenType: Type.Literal("Bearer"),
    expiresIn: Type.Integer({ description: "Access token lifetime in seconds" }),
    user: SessionUser,
  },
  { additionalProperties: false },
);

export const LoginSchema = {
  tags: ["auth"],
  summary: "Sign in with email and password",
  description:
    "Returns a short-lived bearer access token and sets an HttpOnly refresh-token cookie scoped to the auth endpoints. Failed attempts are throttled per email and client IP.",
  body: Type.Object(
    {
      email: Type.String({ format: "email", maxLength: 254 }),
      password: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
    },
    { additionalProperties: false },
  ),
  response: { 200: TokenResponse, ...errorResponses(401, 422, 429) },
};

export const RefreshSchema = {
  tags: ["auth"],
  summary: "Exchange the refresh-token cookie for a new access token",
  description:
    "Rotates the refresh token on every call. Re-using an already rotated refresh token revokes the session. Browsers must call this from an allowed origin.",
  security: [{ refreshCookie: [] }],
  response: { 200: TokenResponse, ...errorResponses(401, 403, 429) },
};

export const LogoutSchema = {
  tags: ["auth"],
  summary: "Revoke the current session and clear the refresh cookie",
  security: [{ refreshCookie: [] }],
  response: { 204: Type.Null(), ...errorResponses(403) },
};

export const SessionSchema = {
  tags: ["auth"],
  summary: "Current signed-in user",
  security: [{ bearerAuth: [] }],
  response: { 200: Type.Object({ user: SessionUser }, { additionalProperties: false }), ...errorResponses(401) },
};

export const ChangePasswordSchema = {
  tags: ["auth"],
  summary: "Change the signed-in user's password",
  description: "Clears the temporary-password requirement and revokes the user's other sessions.",
  security: [{ bearerAuth: [] }],
  body: Type.Object(
    {
      currentPassword: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
      newPassword: Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
    },
    { additionalProperties: false },
  ),
  response: { 204: Type.Null(), ...errorResponses(401, 403, 422) },
};
