import {
	type MemberExecution,
	Store,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import {
	Authorization,
	Caller,
	Developers,
	Execution,
} from "@openbot-build/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Check from "../authorization/Check.ts"
import type { Authorize } from "../execution/Engine.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { ownerKey } from "./StoredConnections.ts"
import type * as Models from "./DeveloperModels.ts"

export const workflowName = "openbot.proof-verification"
export const Reference = Schema.Struct({
	kind: Schema.Literals(["Claim", "Proof"]),
	id: Schema.String,
})
export type Reference = typeof Reference.Type
export const Checked = Schema.Struct({
	previous: Schema.NullOr(Developers.Proof),
	evidence: Developers.ProofEvidence,
})
const sameCaller = Schema.toEquivalence(Caller)
export interface Service {
	readonly request: (
		actor: Caller,
		ref: Reference,
		commandKey: Execution.CommandKey,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			saved: MemberExecution
			ref: Reference
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly complete: (
		fence: Fence,
		checked: typeof Checked.Type,
		report: Models.InspectionReport | null,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Developers.DeveloperConflict
		| Developers.DeveloperForbidden
		| Developers.DeveloperInputInvalid
		| Developers.DeveloperNotFound
		| Developers.DeveloperRestricted
		| Developers.DeveloperUnavailable
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
		| Execution.Failure
	>
}

export class ProofCommands extends Context.Service<ProofCommands, Service>()(
	"@openbot-build/openbot/apps/ProofCommands",
) {}

const make = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const checks = yield* Check.make
	const store = yield* Store
	const sql = yield* SqlClient.SqlClient
	const check = (actor: Caller, ref: Reference) =>
		Effect.gen(function* () {
			yield* checks.check(actor, {
				action: "publish",
				resource: Authorization.App.make({
					organizationId: actor.organizationId,
					ownerUserId: actor.userId,
				}),
			})
			if (ref.kind === "Claim") yield* access.claim(ownerKey(actor), ref.id)
			else yield* access.ownProof(ownerKey(actor), ref.id)
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperForbidden: () => Effect.fail(Execution.Forbidden.make({})),
				PolicyUnavailable: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
			}),
		)
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const ref = yield* Schema.decodeUnknownEffect(Reference)(
				saved.input,
			).pipe(Effect.orDie)
			if (
				saved.workflow !== workflowName ||
				saved.record.resource.kind !== "DeveloperProof" ||
				saved.record.resource.id !== ref.id ||
				key.namespace !== ownerKey(saved.identity.owner)
			)
				return yield* Execution.Forbidden.make({})
			return { saved, ref }
		})
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { saved, ref } = yield* load(key)
			if (
				ownerKey(actor) !== ownerKey(saved.identity.owner) ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			yield* check(actor, ref).pipe(
				Effect.catchTags({
					DeveloperNotFound: () =>
						Effect.fail(Execution.NotFound.make({ id: key.id })),
					SchemaError: Effect.die,
				}),
			)
		})
	const request = (
		actor: Caller,
		ref: Reference,
		commandKey: Execution.CommandKey,
	) =>
		Effect.gen(function* () {
			yield* check(actor, ref)
			return yield* store.accept(
				ownerKey(actor),
				commandKey,
				{ actor, body: { kind: "proof-verification", ref } },
				(create) =>
					Effect.gen(function* () {
						yield* check(actor, ref)
						const key = yield* create({
							workflow: workflowName,
							identity: {
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								actor,
							},
							resource: { kind: "DeveloperProof", id: ref.id },
							input: ref,
						})
						return { executionId: key.id, start: true }
					}),
			)
		})
	const complete = (
		fence: Fence,
		checked: typeof Checked.Type,
		report: Models.InspectionReport | null,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { saved, ref } = yield* load(fence)
					const owner = ownerKey(saved.identity.owner)
					// Domain rows come before execution rows in every commit.
					if (ref.kind === "Claim") yield* access.claim(owner, ref.id, true)
					else yield* access.ownProof(owner, ref.id, true)
					yield* authorize(fence, saved.identity.actor, "advance")
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [{ _tag: "Result", resource: saved.record.resource }],
						},
						Effect.gen(function* () {
							if (ref.kind === "Claim") {
								if (checked.evidence._tag === "Unavailable")
									return yield* Effect.fail(checked.evidence.failure)
								yield* access.confirm(owner, ref.id, checked.evidence, report)
							} else {
								if (checked.previous === null)
									return yield* Effect.die(
										"The proof check has no prior state.",
									)
								yield* access.applyEvidence(
									checked.previous,
									checked.evidence,
									report,
								)
							}
						}),
					)
				}),
			)
			.pipe(transactionFailures)
	return ProofCommands.of({ request, load, authorize, complete })
})

export const layer = Layer.effect(ProofCommands, make)
