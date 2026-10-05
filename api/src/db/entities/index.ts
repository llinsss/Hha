import { ApiSessionEntity } from "./api-session.entity.js";
import { UserEntity } from "./user.entity.js";

export * from "./api-session.entity.js";
export * from "./user.entity.js";

/**
 * Entities are declared with `EntitySchema` rather than decorators: no
 * reflect-metadata, no emitDecoratorMetadata, and identical behaviour under
 * tsc, tsx and vitest. Add new entities to this list.
 */
export const entities = [UserEntity, ApiSessionEntity];
