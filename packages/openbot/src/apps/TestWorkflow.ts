import { GrantCleanup } from "./GrantCleanup.ts"
import { Developers } from "@openbot-build/domain"
import {
	Discovery,
	Document,
	OAuthAuthorization,
} from "@openbot-build/protocol"
import { Effect, Layer, Schema } from "effect"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { DeveloperTestRuntime } from "./DeveloperTestRuntime.ts"
import {
	Preparation,
	Result,
	TestCommands,
	workflowName,
} from "./TestCommands.ts"

export const workflow = Engine.define(workflowName)
export const make = Effect.gen(function* () {
	const commands = yield* TestCommands
	const runtime = yield* DeveloperTestRuntime
	const cleanup = yield* GrantCleanup
	const discovery = yield* Discovery.Discovery
	const calls = yield* Calls
	const store = yield* Store
	const run = yield* Program.make
	const resultCodec = Schema.toCodecJson(Result)
	const candidateCodec = Schema.toCodecJson(Discovery.Candidate)
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const { record, saved, action, exchange } = yield* commands.load(fence)
			const check = commands
				.authorize(fence, saved.identity.actor, "advance")
				.pipe(Effect.andThen(store.guard(fence)))
			yield* check
			const input = { testId: record.value.id }
			if (action._tag === "Exchange") {
				if (exchange === undefined)
					return yield* Effect.die("The saved test exchange is missing.")
				const codec = Schema.toCodecJson(OAuthAuthorization.Grant)
				const result = yield* calls.invoke(
					fence,
					{
						...(yield* cleanup.writeAttempt(
							fence,
							"exchange",
							{
								flowId: exchange.flow.flowId,
							},
							{
								issuer: exchange.flow.binding.issuer,
								clientId: exchange.flow.clientId,
							},
						)),
						onResult: (callId) =>
							cleanup
								.enqueue(fence, callId, exchange.flow.metadata)
								.pipe(Effect.asVoid),
					},
					() =>
						runtime
							.exchange(record.owner, record.value.id, exchange)
							.pipe(
								Effect.flatMap(Schema.encodeEffect(codec)),
								Effect.timeout("30 seconds"),
							),
				)
				if (result._tag === "Unknown") return
				yield* commands.exchanged(
					fence,
					result.callId,
					yield* Schema.decodeEffect(codec)(result.result),
				)
				return
			}
			if (action._tag === "Prepare") {
				const codec = Schema.toCodecJson(Preparation)
				const result = yield* calls.invoke(
					fence,
					yield* store.readAttempt(fence, "prepare", input),
					() =>
						runtime
							.prepare(record.owner, record.value.id, action)
							.pipe(
								Effect.flatMap(Schema.encodeEffect(codec)),
								Effect.timeout("30 seconds"),
							),
				)
				if (result._tag === "Unknown") return
				yield* commands.prepared(
					fence,
					yield* Schema.decodeEffect(codec)(result.result),
				)
				return
			}
			const checked = yield* calls.invoke(
				fence,
				yield* store.readAttempt(fence, "target", input),
				() =>
					discovery
						.refreshCard(record.value.cardUrl)
						.pipe(
							Effect.flatMap(Schema.encodeEffect(candidateCodec)),
							Effect.timeout("1 minute"),
						),
			)
			if (checked._tag === "Unknown") return
			const candidate = yield* Schema.decodeEffect(candidateCodec)(
				checked.result,
			)
			if (
				!Schema.toEquivalence(Schema.UndefinedOr(Document.Remote))(
					record.value.candidate.card.remotes?.[record.value.remoteIndex],
					candidate.card.remotes?.[record.value.remoteIndex],
				)
			)
				return yield* Developers.DeveloperConflict.make({
					reason: "TestTargetChanged",
				})
			const result = yield* calls.invoke(
				fence,
				yield* store.readAttempt(fence, "capabilities", input),
				() =>
					runtime
						.execute(record.owner, record.value.id, {
							check,
							progress: (stages) => commands.progress(fence, stages),
						})
						.pipe(
							Effect.flatMap(Schema.encodeEffect(resultCodec)),
							Effect.timeout("2 minutes"),
						),
			)
			if (result._tag === "Unknown") return
			yield* commands.complete(
				fence,
				yield* Schema.decodeEffect(resultCodec)(result.result),
			)
		})
	return (key: Parameters<typeof run>[0]) => run(key, work, commands.finish)
})
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const run = yield* make
		const commands = yield* TestCommands
		const registry = yield* Engine.Registry
		return workflow
			.toLayer(run)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
