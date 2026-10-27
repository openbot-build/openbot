import { BotId } from "./BotId.ts"
import { DelegationId } from "./DelegationId.ts"
import { TokenId } from "./TokenId.ts"
import * as Execution from "./Execution.ts"
import { Array as Arr, Context, Schema } from "effect"

/**
 * The caller of one request, in one organization.
 * A member signs in with the session cookie. A user token acts for one member.
 */
export const Caller = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("member"),
		userId: Schema.String,
		organizationId: Schema.String,
		tokenId: Schema.optionalKey(Schema.Never),
	}),
	Schema.Struct({
		kind: Schema.Literal("user_token"),
		userId: Schema.String,
		organizationId: Schema.String,
		tokenId: TokenId,
	}),
])
export type Caller = typeof Caller.Type
export class Identity extends Context.Service<Identity, Caller>()(
	"@openbot-build/domain/Identity",
) {}

/** The account of a request that does not act in one organization. */
export const AccountCaller = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("member"),
		userId: Schema.String,
		organizationId: Schema.optionalKey(Schema.String),
		tokenId: Schema.optionalKey(Schema.Never),
	}),
	Schema.Struct({
		kind: Schema.Literal("user_token"),
		userId: Schema.String,
		organizationId: Schema.String,
		tokenId: TokenId,
	}),
])
export type AccountCaller = typeof AccountCaller.Type
export class Account extends Context.Service<Account, AccountCaller>()(
	"@openbot-build/domain/Identity/Account",
) {}

/** The owner and actor stay distinct across a Bot call or a queued command. */
export const ExecutionIdentity = Schema.Struct({
	owner: Schema.Struct({
		organizationId: Schema.String,
		userId: Schema.String,
	}),
	/** The caller that started this work. A later input cannot replace its token. */
	actor: Caller,
	/** Other callers whose current rights also limit this work. */
	constraints: Schema.optionalKey(Schema.Array(Caller)),
	/** The linked speaker that admitted Channel input. Restore checks this link again. */
	channel: Schema.optionalKey(
		Schema.Struct({ id: Schema.String, externalUserId: Schema.String }),
	),
	botId: Schema.optionalKey(BotId),
	delegationId: Schema.optionalKey(DelegationId),
	parentExecutionId: Schema.optionalKey(Execution.Id),
})
export type ExecutionIdentity = typeof ExecutionIdentity.Type

/** A service has its own name. It cannot stand in for a member or token. */
export const ServiceId = Schema.NonEmptyString.pipe(Schema.brand("ServiceId"))
export type ServiceId = typeof ServiceId.Type
export const ServiceCaller = Schema.Struct({
	kind: Schema.Literal("service"),
	serviceId: ServiceId,
})
export type ServiceCaller = typeof ServiceCaller.Type
export const ServiceScope = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("platform") }),
	Schema.Struct({
		kind: Schema.Literal("organization"),
		organizationId: Schema.String,
	}),
])
export type ServiceScope = typeof ServiceScope.Type
export const ServiceIdentity = Schema.Struct({
	owner: ServiceScope,
	actor: ServiceCaller,
})
export type ServiceIdentity = typeof ServiceIdentity.Type

/** The common execution store holds both member work and service work. */
export const WorkIdentity = Schema.Union([ExecutionIdentity, ServiceIdentity])
export type WorkIdentity = typeof WorkIdentity.Type

const sameCaller = Schema.toEquivalence(Caller)

/** Every caller must allow an external act. A saved rule cannot remove a caller. */
export const executionCallers = (
	identity: ExecutionIdentity,
): ReadonlyArray<Caller> =>
	Arr.dedupeWith([identity.actor, ...(identity.constraints ?? [])], sameCaller)

/** Add limits without changing the source, owner, or parent of the work. */
export const restrictExecution = (
	identity: ExecutionIdentity,
	callers: ReadonlyArray<Caller>,
): ExecutionIdentity => {
	const constraints = Arr.filter(
		Arr.dedupeWith([...(identity.constraints ?? []), ...callers], sameCaller),
		(caller) => !sameCaller(caller, identity.actor),
	)
	const { constraints: _, ...source } = identity
	return constraints.length === 0 ? source : { ...source, constraints }
}

/** A child may add limits, but it cannot remove any limit of its source. */
export const keepsExecutionLimits = (
	child: ExecutionIdentity,
	source: ExecutionIdentity,
): boolean =>
	Arr.every(executionCallers(source), (caller) =>
		Arr.some(executionCallers(child), (candidate) =>
			sameCaller(caller, candidate),
		),
	)
