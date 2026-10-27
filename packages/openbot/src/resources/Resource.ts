import { Execution } from "@openbot-build/domain"
import { Schema } from "effect"

/** A physical resource stays on the node that holds its connection. */
export const Ref = Schema.Struct({
	namespace: Schema.String,
	kind: Schema.String,
	id: Schema.String,
})
export type Ref = typeof Ref.Type

/** Every new connection gets a new lease, even at the same node address. */
export const Address = Schema.Struct({
	...Ref.fields,
	lease: Schema.String,
	node: Schema.String,
	host: Schema.String,
	port: Schema.Int,
})
export type Address = typeof Address.Type

export class Gone extends Schema.TaggedError<
	Gone,
	{ readonly brand: unique symbol }
>()("ResourceGone", {
	resource: Ref,
}) {}
export class Busy extends Schema.TaggedError<
	Busy,
	{ readonly brand: unique symbol }
>()("ResourceBusy", {
	resource: Ref,
}) {}
/** No automatic retry is safe after an RPC may have sent an action. */
export class Failed extends Schema.TaggedError<
	Failed,
	{ readonly brand: unique symbol }
>()("ResourceFailed", {
	resource: Ref,
	outcome: Schema.Literals(["not_sent", "unknown"]),
	failure: Execution.Failure,
}) {}
export const Error = Schema.Union([Gone, Busy, Failed])
export type Error = typeof Error.Type

/** A missing close reply is not proof that the physical resource was released. */
export const ReleaseResult = Schema.TaggedUnion({
	Closed: {},
	Failed: { failure: Execution.Failure },
})
export type ReleaseResult = typeof ReleaseResult.Type
