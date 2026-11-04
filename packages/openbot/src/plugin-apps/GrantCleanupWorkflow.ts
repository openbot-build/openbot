import { AppAuthorizations, Execution } from "@openbot-build/domain"
import { Authorization, OAuthAuthorization } from "@openbot-build/protocol"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { DurableClock } from "effect/workflow"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import * as Program from "../server-execution/execution/Program.ts"
import * as RetryingCall from "../server-execution/execution/RetryingCall.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Store, type Fence } from "../server-execution/execution/Store.ts"
import { AppNetwork } from "../apps-contract/apps/AppNetwork.ts"
import {
	GrantCleanup,
	scopeOf,
	serviceId,
	workflowName,
} from "./GrantCleanup.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const cleanup = yield* GrantCleanup
	const network = yield* AppNetwork
	const observation = yield* Observation
	const workflows = yield* Workflows
	const retry = yield* RetryingCall.make
	const run = yield* Program.make
	const store = yield* Store
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			while (true) {
				const next = yield* cleanup.claim(fence)
				if (next._tag === "Wait") {
					// One shared reader handles the wait. A takeover reads the same saved state.
					yield* observation
						.observe(next.key, next.sequence)
						.pipe(Stream.runDrain)
					continue
				}
				if (next._tag === "InUse") {
					if ((yield* store.get(fence)).status !== "waiting")
						yield* store.commit(fence, { status: "waiting" }, Effect.void)
					const state = yield* store.get(fence)
					yield* DurableClock.sleep({
						name: "grant-in-use:" + state.sequence,
						duration: "1 minute",
						inMemoryThreshold: 0,
					})
					yield* store.commit(fence, { status: "running" }, Effect.void)
					continue
				}
				if (next._tag === "Retained") return yield* cleanup.complete(fence)
				let metadata = next.metadata
				if (metadata === undefined) {
					const credential = next.grant.credential
					const resourceMetadataUrl = next.grant.resourceMetadataUrl
					const result = yield* retry(
						fence,
						"metadata",
						{
							issuer: credential.binding.issuer,
							resource: credential.binding.resource,
						},
						() =>
							Effect.scoped(
								Effect.gen(function* () {
									const context = yield* Layer.build(
										network.layer(fence.namespace, [
											new URL(credential.binding.issuer).origin,
											new URL(credential.binding.resource).origin,
											...(resourceMetadataUrl === undefined
												? []
												: [new URL(resourceMetadataUrl).origin]),
										]),
									)
									return yield* OAuthAuthorization.discover({
										issuer: credential.binding.issuer,
										resource: credential.binding.resource,
										...(resourceMetadataUrl === undefined
											? {}
											: { resourceMetadataUrl }),
									}).pipe(
										Effect.provideContext(context),
										Effect.flatMap(({ metadata }) =>
											Schema.encodeEffect(
												Schema.toCodecJson(Authorization.ServerMetadata),
											)(metadata),
										),
									)
								}),
							).pipe(Effect.timeout("30 seconds")),
					)
					if (Option.isNone(result)) return
					metadata = yield* Schema.decodeEffect(
						Schema.toCodecJson(Authorization.ServerMetadata),
					)(result.value)
				}
				const savedMetadata = metadata
				const result = yield* retry(
					fence,
					"revoke",
					{ grantScope: scopeOf(next.grant.credential) },
					() =>
						Effect.scoped(
							Effect.gen(function* () {
								const context = yield* Layer.build(
									network.layer(fence.namespace, [
										new URL(savedMetadata.issuer).origin,
										...(savedMetadata.revocation_endpoint === undefined
											? []
											: [new URL(savedMetadata.revocation_endpoint).origin]),
									]),
								)
								return yield* OAuthAuthorization.revokeCredential({
									credential: next.grant.credential,
									metadata: savedMetadata,
								}).pipe(
									Effect.provideContext(context),
									Effect.flatMap(
										Schema.encodeEffect(AppAuthorizations.Revocation),
									),
								)
							}),
						).pipe(Effect.timeout("30 seconds")),
				)
				if (Option.isSome(result)) yield* cleanup.complete(fence)
				return
			}
		})
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: (key) => run(key, work, cleanup.finish),
		policy: Policy.Service({
			serviceId: serviceId,
			authorize: cleanup.authorize,
			publicRead: (key, actor) =>
				Effect.gen(function* () {
					const saved = yield* cleanup.load(key)
					const source = yield* workflows.get(saved.source.workflow)
					if (Option.isNone(source)) return yield* Execution.Forbidden.make({})
					yield* source.value.authorize(saved.sourceKey, actor, "read")
				}),
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
