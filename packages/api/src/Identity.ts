import { TokenId } from "./TokenId.ts"
import { Context, Schema } from "effect"

/**
 * The caller of one request, in one organization.
 * A member signs in with the session cookie. A user token acts for one member.
 */
export const Caller = Schema.Struct({
	kind: Schema.Literals(["member", "user_token"]),
	userId: Schema.String,
	organizationId: Schema.String,
	tokenId: Schema.optionalKey(TokenId),
})
export type Caller = typeof Caller.Type
export class Identity extends Context.Service<Identity, Caller>()(
	"@openbot-build/api/Identity",
) {}

/** The account of a request that does not act in one organization. */
export const AccountCaller = Schema.Struct({
	kind: Schema.Literals(["member", "user_token"]),
	userId: Schema.String,
	/** A user token belongs to one organization, so it also has this. */
	tokenId: Schema.optionalKey(TokenId),
	organizationId: Schema.optionalKey(Schema.String),
})
export type AccountCaller = typeof AccountCaller.Type
export class Account extends Context.Service<Account, AccountCaller>()(
	"@openbot-build/api/Identity/Account",
) {}
