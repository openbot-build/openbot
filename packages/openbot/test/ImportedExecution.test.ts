import { AccountCaller } from "@openbot-build/domain"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import {
	Authorization,
	Execution,
	TokenId,
	type Caller,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { WorkflowEngine } from "effect/workflow"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { Tokens } from "../src/auth/Tokens.ts"
import { policyOf } from "../src/authorization/Load.ts"
import { Bots } from "../src/bots/Bots.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Authority from "../src/database/conversion/Authority.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as ImportedWorkflow from "../src/database/conversion/ImportedWorkflow.ts"
import * as Legacy from "../src/database/conversion/LegacyV1.ts"
import * as Commands from "../src/execution/Commands.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Records from "../src/errors/Records.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Store from "../src/execution/Store.ts"
import * as ErrorRecords from "../src/errors/Records.ts"
import { Organization } from "../src/organization/Organization.ts"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Fixture from "./OrganizationFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Observation.layer.pipe(
	Layer.provideMerge(Store.layer),
	Layer.provideMerge(Records.layer),
	Layer.provideMerge(ErrorRecords.layer),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const readOnly = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("read", Authorization.Chat)
})
const writeOnly = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("write", Authorization.Chat)
})
const denied = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	work.pipe(
		Effect.flip,
		Effect.tap((error) =>
			Effect.sync(() => assert.ok(Schema.is(Execution.Forbidden)(error))),
		),
	)
const setup = Effect.fn(function* (
	name: string,
	status: Imported.RecordInput["status"] = "outcome_unknown",
	count = 2,
) {
	const sql = yield* PgClient.PgClient
	const store = yield* Store.Store
	const writer = yield* Imported.make
	const actor: Caller = {
		kind: "member",
		organizationId: "import-org",
		userId: name,
	}
	const token: Caller = {
		...actor,
		kind: "user_token",
		tokenId: TokenId.make("import-token"),
	}
	const namespace = ownerKey(actor)
	const owner = { organizationId: actor.organizationId, userId: actor.userId }
	yield* sql`insert into openbot_chats ${sql.insert({ namespace, id: name, body: "{}", state: "{}", bot: name, kind: "direct", status: "Idle", revision: 0, inbox_size: 0, created_at: 1, updated_at: 1 })}`
	const key = yield* sql.withTransaction(
		writer.write({
			namespace,
			collection: "test",
			sourceKey: name,
			resource: { kind: "AppCall", id: name },
			context: { kind: "Chat", id: name },
			input: {
				_tag: "Imported",
				format: 1,
				source: Legacy.source,
				owner,
				authority: Authority.missing(owner),
				reason:
					status === "outcome_unknown" ? "OutsideResultUnknown" : "History",
				history: { text: "private old result" },
			},
			status,
			createdAt: 1,
			updatedAt: 2,
			calls:
				status === "outcome_unknown"
					? Arr.makeBy(count, (index) => ({
							step: `write:${index}`,
							attempt: 1,
							status: "outcome_unknown" as const,
							input: { text: "private old call" },
							result: null,
						}))
					: [],
		}),
	)
	const state = yield* Ref.make({
		token: true,
		member: true,
		policy: Authorization.defaultTokenPolicy,
		expiresAt: null as string | null,
	})
	const policy = Authorizer.layer(Authorization.Auth, {
		policy: (caller) =>
			Schema.decodeUnknownEffect(AccountCaller)(caller).pipe(
				Effect.flatMap((caller) => policyOf(caller, { platform: false })),
			),
	}).pipe(
		Layer.provide(
			Layer.mergeAll(
				Fixture.layerBuiltinRoles,
				Fixture.layerDefaultSettings,
				Layer.mock(PlatformAdmins, { check: () => Effect.succeed(false) }),
				Layer.mock(Organization, {
					activeMember: (_, userId) =>
						Ref.get(state).pipe(
							Effect.map((value) =>
								value.member
									? Option.some({
											userId,
											email: null,
											name: null,
											status: "active" as const,
											roles: ["member"],
											policy: Authorization.emptyPolicy,
											joinedAt: "2026-01-01T00:00:00.000Z",
										})
									: Option.none(),
							),
						),
				}),
				Layer.mock(Tokens, {
					find: (owner, id) =>
						Ref.get(state).pipe(
							Effect.map((value) =>
								value.token &&
								ownerKey(owner) === namespace &&
								id === token.tokenId
									? Option.some({
											id: token.tokenId,
											name: "test",
											prefix: "obut_test",
											policy: value.policy,
											createdAt: "2026-01-01T00:00:00.000Z",
											expiresAt: value.expiresAt,
											lastUsedAt: null,
										})
									: Option.none(),
							),
						),
				}),
			),
		),
	)
	const context = yield* Layer.build(
		Layer.merge(Commands.layer, ImportedWorkflow.layer).pipe(
			Layer.provideMerge(Engine.layerRegistry),
			Layer.provide(WorkflowEngine.layerMemory),
			Layer.provide(policy),
			Layer.provide(Layer.mock(Bots, { find: () => Effect.succeedNone })),
		),
	)
	const commands = Context.get(context, Commands.Commands)
	const registry = Context.get(context, Engine.Registry)
	const calls = yield* store.calls(key)
	const decision = (
		index: number,
		commandKey = `stop:${index}`,
		answer: Execution.Answer = "stop",
	) => {
		const call = Option.getOrThrow(Arr.get(calls, index))
		return {
			commandKey: Execution.CommandKey.make(commandKey),
			decisionId: call.id,
			answer,
		}
	}
	return {
		actor,
		token,
		state,
		key,
		calls,
		decision,
		commands,
		registry,
		store,
		sql,
	}
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("all saved stop decisions end imported work once", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("all-stops")
				const before = yield* test.commands.get(test.key.id, test.actor)
				const first = yield* test.commands.decide(
					test.key.id,
					test.actor,
					test.decision(0),
				)
				assert.equal(
					(yield* test.commands.get(test.key.id, test.actor)).status,
					"outcome_unknown",
				)
				const [last, repeated] = yield* Effect.all(
					[
						test.commands.decide(test.key.id, test.actor, test.decision(1)),
						test.commands.decide(test.key.id, test.actor, test.decision(1)),
					],
					{ concurrency: 2 },
				)
				assert.deepEqual(last, repeated)
				assert.deepEqual(
					yield* test.commands.decide(
						test.key.id,
						test.actor,
						test.decision(0),
					),
					first,
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* test.commands
							.decide(test.key.id, test.actor, test.decision(1, "stop:0"))
							.pipe(Effect.flip),
					),
				)
				const after = yield* test.commands.get(test.key.id, test.actor)
				assert.equal(after.status, "interrupted")
				assert.equal(after.failure?.category, "interrupted")
				assert.equal(after.failure?.errorId, before.failure?.errorId)
				assert.equal(after.sequence, before.sequence + 3)
				assert.deepEqual(yield* test.store.calls(test.key), test.calls)
				const events = yield* test.commands.events(
					test.key.id,
					test.actor,
					before.sequence,
				)
				assert.isTrue(events.terminal)
				assert.deepEqual(
					Arr.map(events.events, (event) => event.body._tag),
					["DecisionMade", "DecisionMade", "State"],
				)
				const observed = yield* test.commands
					.observe(test.key.id, test.actor, 0)
					.pipe(Stream.runCollect)
				assert.equal(observed.length, after.sequence)
				assert.equal((yield* test.store.load(test.key)).generation, 0)
				assert.equal(
					(yield* test.store.load(test.key)).identity.actor.kind,
					"service",
				)
			}),
		),
	)

	it.effect("imported decisions reject every answer except stop", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("stop-only")
				const before = yield* test.commands.get(test.key.id, test.actor)
				for (const answer of ["retry", "allow", "deny"] as const)
					assert.ok(
						Schema.is(Execution.Conflict)(
							yield* test.commands
								.decide(
									test.key.id,
									test.actor,
									test.decision(0, answer, answer),
								)
								.pipe(Effect.flip),
						),
					)
				assert.deepEqual(
					yield* test.commands.get(test.key.id, test.actor),
					before,
				)
				assert.deepEqual(yield* test.store.calls(test.key), test.calls)
				const registration = Option.getOrThrow(
					yield* test.registry.get(Imported.workflowName),
				)
				for (const access of ["cancel", "advance", "replay"] as const)
					yield* denied(registration.authorize(test.key, test.actor, access))
				for (const access of [
					"read",
					"cancel",
					"decide",
					"advance",
					"replay",
				] as const)
					yield* denied(
						registration.authorize(
							test.key,
							{ kind: "service", serviceId: Imported.serviceId },
							access,
						),
					)
				yield* denied(
					test.commands.cancel(
						test.key.id,
						test.actor,
						Execution.CommandKey.make("cancel"),
					),
				)
			}),
		),
	)

	it.effect("imported work checks the current account and resource", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("current-owner")
				const other: Caller = { ...test.actor, userId: "other-member" }
				yield* denied(test.commands.get(test.key.id, other))
				yield* denied(
					test.commands.decide(test.key.id, other, test.decision(0)),
				)
				assert.ok(
					Schema.is(Execution.NotFound)(
						yield* test.commands
							.get(test.key.id, { ...test.actor, organizationId: "other-org" })
							.pipe(Effect.flip),
					),
				)
				yield* test.sql`update openbot_chats set namespace = ${ownerKey(other)} where namespace = ${test.key.namespace} and id = ${test.actor.userId}`
				yield* denied(test.commands.get(test.key.id, test.actor))
				yield* denied(
					test.commands.decide(test.key.id, test.actor, test.decision(0)),
				)
			}),
		),
	)

	for (const change of ["revoked", "expired", "member", "policy"] as const)
		it.effect(`an imported stop checks a ${change} right again`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const test = yield* setup(`right-${change}`)
					yield* test.commands.get(test.key.id, test.token)
					yield* Ref.update(test.state, (state) => ({
						...state,
						token: change !== "revoked",
						member: change !== "member",
						expiresAt: change === "expired" ? "2000-01-01T00:00:00.000Z" : null,
						policy: change === "policy" ? readOnly : state.policy,
					}))
					yield* denied(
						test.commands.decide(test.key.id, test.token, test.decision(0)),
					)
					if (change === "policy")
						yield* test.commands.get(test.key.id, test.token)
					else yield* denied(test.commands.get(test.key.id, test.token))
					assert.equal(
						(yield* test.store.get(test.key)).status,
						"outcome_unknown",
					)
				}),
			),
		)

	it.effect("a saved imported receipt still checks the current token", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("saved-revoked", "outcome_unknown", 1)
				const receipt = yield* test.commands.decide(
					test.key.id,
					test.token,
					test.decision(0),
				)
				yield* Ref.update(test.state, (state) => ({ ...state, token: false }))
				yield* denied(
					test.commands.decide(test.key.id, test.token, test.decision(0)),
				)
				yield* Ref.update(test.state, (state) => ({ ...state, token: true }))
				assert.deepEqual(
					yield* test.commands.decide(
						test.key.id,
						test.token,
						test.decision(0),
					),
					receipt,
				)
			}),
		),
	)

	it.effect("an imported stop needs the right to read its resource", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("read-before-stop")
				yield* Ref.update(test.state, (state) => ({
					...state,
					policy: writeOnly,
				}))
				yield* denied(
					test.commands.decide(test.key.id, test.token, test.decision(0)),
				)
				assert.equal(
					(yield* test.store.get(test.key)).status,
					"outcome_unknown",
				)
			}),
		),
	)

	it.effect("an imported final stop and its receipt roll back together", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const test = yield* setup("rollback-stop", "outcome_unknown", 1)
				const before = yield* test.store.get(test.key)
				yield* test.sql
					.withTransaction(
						test.commands
							.decide(test.key.id, test.actor, test.decision(0))
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				assert.deepEqual(yield* test.store.get(test.key), before)
				assert.equal(
					Option.getOrThrow(
						yield* test.store.decision(test.key, test.decision(0).decisionId),
					).answer,
					null,
				)
				assert.equal(
					Arr.filter(
						yield* test.store.pending([Imported.workflowName]),
						(message) => message.executionId === test.key.id,
					).length,
					0,
				)
				yield* test.commands.decide(test.key.id, test.actor, test.decision(0))
				assert.equal((yield* test.store.get(test.key)).status, "interrupted")
			}),
		),
	)

	for (const status of [
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	] as const)
		it.effect(`imported ${status} history can be read again`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const test = yield* setup(`terminal-${status}`, status)
					const first = yield* test.commands.get(test.key.id, test.actor)
					const events = yield* test.commands
						.observe(test.key.id, test.token, 0)
						.pipe(Stream.runCollect)
					assert.equal(first.status, status)
					assert.deepEqual(
						Arr.map(events, (event) => event.body._tag),
						["Result", "State"],
					)
					assert.deepEqual(
						yield* test.commands.get(test.key.id, test.token),
						first,
					)
					assert.equal(
						(yield* test.commands.events(
							test.key.id,
							test.actor,
							first.sequence,
						)).events.length,
						0,
					)
					const registration = Option.getOrThrow(
						yield* test.registry.get(Imported.workflowName),
					)
					yield* registration.signal(test.key, "old-decision")
					assert.deepEqual(
						yield* test.commands.get(test.key.id, test.actor),
						first,
					)
				}),
			),
		)
})
