import { Records } from "../errors/Records.ts"
import * as Models from "./DeveloperModels.ts"
import { Developers, Execution } from "@openbot-build/domain"
import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import {
	Checked,
	ProofCommands,
	Reference,
	workflowName,
} from "./ProofCommands.ts"
import { ownerKey } from "./StoredConnections.ts"

export const workflow = Engine.define(workflowName)
const checkedCodec = Schema.toCodecJson(Checked)
const Report = Schema.TaggedUnion({
	Inspected: { report: Models.InspectionReport },
	Failed: { failure: Execution.Failure },
})
const reportCodec = Schema.toCodecJson(Report)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* ProofCommands
		const access = yield* DeveloperAccess
		const calls = yield* Calls
		const store = yield* Store
		const errors = yield* Records
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		const work = (fence: Fence) =>
			Effect.gen(function* () {
				const { saved, ref } = yield* commands.load(fence)
				yield* commands.authorize(fence, saved.identity.actor, "advance")
				const owner = ownerKey(saved.identity.owner)
				// Read and decode records before recording an external send.
				const prepared =
					ref.kind === "Claim"
						? {
								kind: "Claim" as const,
								value: yield* access.claim(owner, ref.id),
							}
						: {
								kind: "Proof" as const,
								value: yield* access.ownProof(owner, ref.id),
							}
				if (
					prepared.kind === "Proof" &&
					prepared.value.value.status === "Relinquished"
				)
					return yield* Developers.DeveloperConflict.make({
						reason: "ProofRelinquished",
					})
				if (prepared.kind === "Claim") {
					if (prepared.value.status === "Confirmed")
						return yield* commands.complete(
							fence,
							{ previous: null, evidence: { _tag: "Matched" } },
							null,
						)
					if (prepared.value.status !== "Pending")
						return yield* Developers.DeveloperConflict.make({
							reason: "ClaimInactive",
						})
					if (prepared.value.expiresAt <= (yield* Clock.currentTimeMillis))
						return yield* Developers.DeveloperConflict.make({
							reason: "ClaimExpired",
						})
				}
				const input = yield* Schema.encodeEffect(Schema.toCodecJson(Reference))(
					ref,
				)
				const outcome = yield* calls.invoke(
					fence,
					yield* store.readAttempt(fence, "evidence", input),
					() =>
						Effect.gen(function* () {
							const previous =
								prepared.kind === "Proof" ? prepared.value.value : null
							const scope =
								prepared.kind === "Proof"
									? prepared.value.value.scope
									: prepared.value.scope
							const evidence = yield* access.checkEvidence(
								scope,
								prepared.value.token,
							)
							return yield* Schema.encodeEffect(checkedCodec)({
								previous,
								evidence,
							})
						}).pipe(Effect.timeout("2 minutes")),
				)
				if (outcome._tag === "Unknown") return
				const checked = yield* Schema.decodeEffect(checkedCodec)(outcome.result)
				let report: Models.InspectionReport | null = null
				if (checked.evidence._tag === "Matched") {
					const scope =
						checked.previous?.scope ??
						(prepared.kind === "Claim"
							? prepared.value.scope
							: prepared.value.value.scope)
					const inspected = yield* calls.invoke(
						fence,
						yield* store.readAttempt(fence, "inspection", input),
						() =>
							access.inspectScope(scope).pipe(
								Effect.timeout("2 minutes"),
								Effect.map((report): typeof Report.Type => ({
									_tag: "Inspected",
									report,
								})),
								Effect.catchCauseIf(
									(cause) => !Cause.hasInterrupts(cause),
									(cause) =>
										errors.record(cause, "external", fence.id).pipe(
											Effect.map((failure): typeof Report.Type => ({
												_tag: "Failed",
												failure,
											})),
										),
								),
								Effect.flatMap(Schema.encodeEffect(reportCodec)),
							),
					)
					if (inspected._tag === "Unknown") return
					const result = yield* Schema.decodeEffect(reportCodec)(
						inspected.result,
					)
					report = result._tag === "Inspected" ? result.report : null
				}
				yield* commands.complete(fence, checked, report)
			})
		return workflow
			.toLayer((key) => run(key, work))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
