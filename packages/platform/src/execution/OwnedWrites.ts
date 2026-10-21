import { Effect, Option, Schema } from "effect"
import * as Fence from "./ExecutionFence.ts"

const Owner = Schema.fromJsonString(
	Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]),
)
/** Account stores use an organization and user pair. Invalid owners never match a lease. */
export const accountId = (owner: string): string =>
	Option.getOrElse(Schema.decodeOption(Owner)(owner), () => ["", ""])[1]

/** Hold a durable lease until the account write has settled. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const write = <A, E, R>(owner: string, effect: Effect.Effect<A, E, R>) =>
	Fence.guard(accountId(owner), "write", effect)

/** Startup recovery only touches accounts still assigned to this runtime. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const recover = <A, E, R>(
	owner: string,
	effect: Effect.Effect<A, E, R>,
) =>
	Fence.admit(accountId(owner), write(owner, effect)).pipe(
		Effect.asVoid,
		Effect.catchTag("FenceUnavailable", () =>
			Effect.logWarning("Account recovery is blocked by its execution route"),
		),
	)

/** Session namespaces are bound to an account by authenticated request or host context. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const sessionWrite = <A, E, R>(
	namespace: string,
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.flatMap(Fence.CurrentSessionOwner, (owner) =>
		Fence.guard(
			owner?.namespace === namespace ? owner.accountId : "",
			"write",
			effect,
		),
	)
