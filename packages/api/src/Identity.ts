import { Context, Schema } from "effect"

/**
 * The caller of one request, in one organization.
 * A member signs in with the session cookie. A user token acts for one member.
 */
export const Caller = Schema.Struct({
	kind: Schema.Literals(["member", "user_token"]),
	userId: Schema.String,
	organizationId: Schema.String,
	tokenId: Schema.optionalKey(Schema.String),
})
export type Caller = typeof Caller.Type
export class Identity extends Context.Service<Identity, Caller>()(
	"@openbot-build/api/Identity",
) {}
