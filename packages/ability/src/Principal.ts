/**
 * A principal is the one who asks to do an act. It may be a person, a user
 * token, or a Bot.
 *
 * A principal is a Schema. Make it with {@link Class}, in the same way as
 * `Schema.Class`, or use any `Schema.Struct`. Conditions can use the fields of
 * the principal. See `Condition.Builder.principal`.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Schema from "effect/Schema"

/**
 * Any Schema that can be a principal. Its type must be an object.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Schema.Top & { readonly Type: object }

/**
 * Makes a principal as a Schema class. It is the same as `Schema.Class`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Principal } from "@nmnmcc/ability"
 *
 * class Caller extends Principal.Class<Caller>("Caller")({
 *   userId: Schema.String,
 *   organizationId: Schema.String,
 * }) {}
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Class: typeof Schema.Class = Schema.Class
