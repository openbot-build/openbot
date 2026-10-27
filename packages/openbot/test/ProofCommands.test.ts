import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import { Network, RobotsPolicy } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Records from "../src/errors/Records.ts"
import * as Store from "../src/execution/Store.ts"
import * as Access from "../src/apps/DeveloperAccess.ts"
import * as Watches from "../src/apps/DeveloperWatches.ts"
import * as Commands from "../src/apps/ProofCommands.ts"
import { DomainControl } from "../src/apps/DomainControl.ts"
import { AppInspections } from "../src/apps/AppInspections.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Postgres from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Access.layer.pipe(
	Layer.provideMerge(Watches.layer),
	Layer.provideMerge(Layer.merge(Store.layer, Records.layer)),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provide(
		Layer.mergeAll(
			Layer.mock(DomainControl, {}),
			Layer.mock(Network.PublicNetwork, {}),
			Layer.mock(AppInspections, {}),
			RobotsPolicy.layer,
		),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const actor = {
	kind: "user_token",
	organizationId: "org",
	userId: "user",
	tokenId: TokenId.make("proof-token"),
} as const
const checked = { previous: null, evidence: { _tag: "Matched" } } as const
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"proof commands keep the caller and reject cancelled, revoked and old owners",
		() =>
			Effect.gen(function* () {
				const revoked = yield* Ref.make(false)
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Ref.get(revoked).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny) yield* _.deny("publish", Authorization.App)
								}),
							),
						),
				})
				yield* Effect.gen(function* () {
					const commands = yield* Commands.ProofCommands
					const access = yield* Access.DeveloperAccess
					const store = yield* Store.Store
					const owner = ownerKey(actor)
					const claim = yield* access.start(owner, {
						_tag: "PublisherHostname",
						hostname: "proof.example",
					})
					const ref = { kind: "Claim", id: claim.id } as const
					const receipts = yield* Effect.all(
						Arr.makeBy(12, () =>
							commands.request(actor, ref, Execution.CommandKey.make("one")),
						),
						{ concurrency: "unbounded" },
					)
					const key = { namespace: owner, id: receipts[0]!.executionId }
					assert.isTrue(
						Arr.every(receipts, (receipt) => receipt.executionId === key.id),
					)
					assert.deepEqual((yield* store.loadMember(key)).identity.actor, actor)
					const other = yield* access.start(owner, claim.scope)
					assert.propertyVal(
						yield* commands
							.request(
								actor,
								{ kind: "Claim", id: other.id },
								Execution.CommandKey.make("one"),
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionKeyConflict",
					)
					assert.propertyVal(
						yield* commands
							.request(
								{ ...actor, userId: "other" },
								ref,
								Execution.CommandKey.make("other"),
							)
							.pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					const first = yield* store.takeOver(key)
					const second = yield* store.takeOver(key)
					assert.propertyVal(
						yield* commands.complete(first, checked, null).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* Ref.set(revoked, true)
					assert.propertyVal(
						yield* commands.complete(second, checked, null).pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					assert.propertyVal(
						yield* commands
							.authorize(
								key,
								{
									kind: "member",
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								"replay",
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(revoked, false)
					yield* store.cancel(key, Execution.CommandKey.make("cancel"), actor)
					assert.propertyVal(
						yield* commands.complete(second, checked, null).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* store.finishCancellation(
						second,
						(yield* store.loadMember(key)).cancelEpoch,
						() => Effect.succeed([]),
					)
					assert.equal((yield* store.get(key)).status, "cancelled")
					assert.equal((yield* access.claim(owner, claim.id)).status, "Pending")
					assert.propertyVal(
						yield* access.ownProof(owner, claim.id).pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					const next = yield* commands.request(
						actor,
						ref,
						Execution.CommandKey.make("next"),
					)
					const nextFence = yield* store.takeOver({
						namespace: owner,
						id: next.executionId,
					})
					yield* access.revoke(owner, claim.id)
					assert.propertyVal(
						yield* commands
							.complete(nextFence, checked, null)
							.pipe(Effect.flip),
						"_tag",
						"DeveloperConflict",
					)
					assert.propertyVal(
						yield* access.ownProof(owner, claim.id).pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
				}).pipe(Effect.provide(Commands.layer.pipe(Layer.provide(auth))))
			}),
	)
	it.effect(
		"a proof and its result roll back together and can commit after a failed write",
		() =>
			Effect.gen(function* () {
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Effect.succeed(
							Policy.define(Authorization.OpenBot)(function* (_) {
								yield* _.allow("*", "*")
							}),
						),
				})
				yield* Effect.gen(function* () {
					const commands = yield* Commands.ProofCommands
					const access = yield* Access.DeveloperAccess
					const store = yield* Store.Store
					const sql = yield* SqlClient.SqlClient
					const owner = ownerKey(actor)
					const claim = yield* access.start(owner, {
						_tag: "PublisherHostname",
						hostname: "atomic.example",
					})
					const receipt = yield* commands.request(
						actor,
						{ kind: "Claim", id: claim.id },
						Execution.CommandKey.make("atomic"),
					)
					const fence = yield* store.takeOver({
						namespace: owner,
						id: receipt.executionId,
					})
					const before = yield* store.get(fence)
					yield* sql`create function reject_proof_watch() returns trigger language plpgsql as $$ begin raise exception 'Fixture watch write failure'; end $$`
					yield* sql`create trigger reject_proof_watch before insert on openbot_developer_watches for each row execute function reject_proof_watch()`
					assert.propertyVal(
						yield* commands.complete(fence, checked, null).pipe(Effect.flip),
						"_tag",
						"ExecutionStorageError",
					)
					assert.deepEqual(yield* store.get(fence), before)
					assert.equal((yield* access.claim(owner, claim.id)).status, "Pending")
					assert.propertyVal(
						yield* access.ownProof(owner, claim.id).pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					yield* sql`drop trigger reject_proof_watch on openbot_developer_watches`
					yield* sql`drop function reject_proof_watch()`
					yield* commands.complete(fence, checked, null)
					assert.equal((yield* store.get(fence)).status, "completed")
					assert.equal(
						(yield* access.ownProof(owner, claim.id)).value.status,
						"Confirmed",
					)
					assert.isTrue(
						Arr.some(
							yield* store.events(fence, before.sequence),
							(event) =>
								event.body._tag === "Result" &&
								event.body.resource.id === claim.id,
						),
					)
					assert.equal(
						(yield* commands.request(
							actor,
							{ kind: "Claim", id: claim.id },
							Execution.CommandKey.make("atomic"),
						)).executionId,
						receipt.executionId,
					)
				}).pipe(Effect.provide(Commands.layer.pipe(Layer.provide(auth))))
			}),
	)
})
