import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import {
	Authorization,
	Computers as Domain,
	Execution,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { WorkflowEngine } from "effect/workflow"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { Bots } from "../src/bots/Bots.ts"
import * as Activity from "../src/computers/Activity.ts"
import {
	Machine,
	Provider,
	ComputerCallFailed,
} from "../src/computers/Computer.ts"
import { ComputerProviders } from "../src/computers/ComputerProviders.ts"
import { Drivers } from "../src/computers/Drivers.ts"
import * as Lifecycle from "../src/computers/Lifecycle.ts"
import * as LifecycleWorkflow from "../src/computers/LifecycleWorkflow.ts"
import * as Maintenance from "../src/computers/Maintenance.ts"
import * as MaintenanceWorkflow from "../src/computers/MaintenanceWorkflow.ts"
import { Connectors } from "../src/computers/connector/Connectors.ts"
import * as Db from "../src/database/Database.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import {
	computerProviders,
	computers,
	computerUsage,
	executions,
} from "../src/database/Schema.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Store from "../src/execution/Store.ts"
import * as Records from "../src/errors/Records.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Postgres from "./PostgresTest.ts"

class Allowed extends Context.Service<Allowed, Ref.Ref<boolean>>()(
	"@openbot-build/openbot/test/ComputerLifecycle.test/Allowed",
) {}
class Sends extends Context.Service<Sends, Ref.Ref<ReadonlyArray<string>>>()(
	"@openbot-build/openbot/test/ComputerLifecycle.test/Sends",
) {}
const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const auth = Authorizer.layer(Authorization.Auth, {
	policy: () =>
		Effect.flatMap(Allowed, (allowed) =>
			Effect.map(Ref.get(allowed), (yes) =>
				Policy.define(Authorization.OpenBot)(function* (_) {
					if (yes) yield* _.allow("*", "*")
				}),
			),
		),
})
const drivers = Layer.effect(
	Drivers,
	Effect.gen(function* () {
		const sends = yield* Sends
		const record = (name: string) => Ref.update(sends, Arr.append(name))
		return Drivers.of({
			make: () =>
				Effect.succeed(
					new Provider({
						kind: "e2b",
						verify: Effect.void,
						create: () => record("create").pipe(Effect.as({ ref: "sandbox" })),
						attach: () =>
							Effect.succeed(
								new Machine({
									state: Effect.succeed("running"),
									destroy: record("remove"),
									pausable: {
										pause: record("pause"),
										resume: record("resume"),
									},
									shell: {
										start: () => Effect.die("No process is needed."),
										read: () => Effect.die("No file is needed."),
										write: () => Effect.die("No write is needed."),
										list: () => Effect.die("No list is needed."),
										remove: () => Effect.die("No file removal is needed."),
									},
								}),
							),
					}),
				),
		})
	}),
)
const provider = Domain.ComputerProviderId.make("provider")
const services = Layer.merge(Lifecycle.layer, Maintenance.layer).pipe(
	Layer.provideMerge(drivers),
	Layer.provideMerge(Layer.mock(Connectors, { close: () => Effect.void })),
	Layer.provideMerge(Layer.mock(AuditLog, { record: () => Effect.void })),
	Layer.provideMerge(Layer.mock(Bots, { find: () => Effect.succeedNone })),
	Layer.provideMerge(
		Layer.mock(ComputerProviders, {
			get: () =>
				Effect.succeed({
					id: provider,
					kind: "e2b",
					name: "Provider",
					owner: { _tag: "Organization" },
					credentials: {
						kind: "e2b",
						apiKey: { set: true, hint: null },
						apiUrl: null,
						sandboxDomain: null,
					},
					version: 0,
					createdAt: 0,
					updatedAt: 0,
				}),
			credentials: () =>
				Effect.succeed({
					credentials: { kind: "e2b", apiKey: Redacted.make("secret-key") },
					version: 0,
				}),
		}),
	),
	Layer.provideMerge(auth),
	Layer.provideMerge(
		Layer.mergeAll(
			Layer.effect(Allowed, Ref.make(true)),
			Layer.effect(Sends, Ref.make<ReadonlyArray<string>>([])),
		),
	),
	Layer.provideMerge(Calls.layer),
	Layer.provideMerge(Observation.layer),
	Layer.provideMerge(
		Layer.mergeAll(Store.layer, Records.layer, Engine.layerRegistry),
	),
	Layer.provideMerge(WorkflowEngine.layerMemory),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("56"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const caller = (organizationId: string) =>
	({ kind: "member", organizationId, userId: "owner" }) as const
const setup = Effect.fn(function* (organizationId: string) {
	const db = yield* Db.make
	yield* Ref.set(yield* Allowed, true)
	yield* Ref.set(yield* Sends, [])
	yield* db.insert(computerProviders).values({
		organizationId,
		id: provider,
		ownerUserId: null,
		name: "Provider",
		kind: "e2b",
		credentials: "sealed by fixture",
		hints: "{}",
		version: 0,
		createdAt: 0,
		updatedAt: 0,
	})
	const commands = yield* Lifecycle.Lifecycle
	const maintenance = yield* Maintenance.Maintenance
	const registry = yield* Engine.Registry
	yield* registry.register(LifecycleWorkflow.workflow, commands.authorize)
	yield* registry.registerService(
		MaintenanceWorkflow.sweep,
		Maintenance.serviceId,
		(key) => maintenance.loadSweep(key).pipe(Effect.asVoid),
	)
	yield* registry.registerService(
		MaintenanceWorkflow.pause,
		Maintenance.serviceId,
		maintenance.authorizePause,
		undefined,
		maintenance.publicAccess,
		{ authorize: maintenance.publicAccess, decide: maintenance.decide },
	)
	const actor = caller(organizationId)
	return {
		commands,
		maintenance,
		identity: { owner: actor, actor },
		work: yield* LifecycleWorkflow.make,
	}
})
const create = (
	commands: Lifecycle.Lifecycle["Service"],
	identity: {
		owner: ReturnType<typeof caller>
		actor: ReturnType<typeof caller>
	},
	key = "create",
) =>
	commands.submit(identity, Execution.CommandKey.make(key), {
		_tag: "Create",
		request: {
			name: "Box",
			source: { _tag: "Provider", provider, template: null },
			pauseAfter: 60,
		},
	})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"one Computer command stores one result through replay and takeover",
		() =>
			Effect.gen(function* () {
				const { commands, identity, work } = yield* setup("computer-replay")
				const store = yield* Store.Store
				const receipts = yield* Effect.all(
					[create(commands, identity), create(commands, identity)],
					{ concurrency: 2 },
				)
				assert.deepStrictEqual(receipts[0], receipts[1])
				const key = {
					namespace: identity.owner.organizationId,
					id: receipts[0]!.executionId,
				}
				const fence = yield* store.takeOver(key)
				yield* work(fence)
				const state = yield* store.get(key)
				assert.equal(state.status, "completed")
				assert.deepStrictEqual(yield* Ref.get(yield* Sends), ["create"])
				const changed = yield* commands
					.submit(identity, Execution.CommandKey.make("create"), {
						_tag: "Create",
						request: { name: "Changed", source: { _tag: "Connector" } },
					})
					.pipe(Effect.flip)
				assert.equal(changed._tag, "ExecutionKeyConflict")
				const active = yield* Activity.make
				assert.equal(
					(yield* active.row(key.namespace, state.resource.id)).pipe(
						Option.getOrThrow,
					).ref,
					"sandbox",
				)
				const pause = yield* commands.submit(
					identity,
					Execution.CommandKey.make("pause"),
					{ _tag: "Pause", id: state.resource.id },
				)
				const blocked = yield* active
					.mark(key.namespace, state.resource.id)
					.pipe(Effect.flip)
				assert.equal(blocked._tag, "ComputerConflict")
				const second = yield* commands
					.submit(identity, Execution.CommandKey.make("resume"), {
						_tag: "Resume",
						id: state.resource.id,
					})
					.pipe(Effect.flip)
				assert.equal(second._tag, "ComputerConflict")
				const first = yield* store.takeOver({
					namespace: key.namespace,
					id: pause.executionId,
				})
				const next = yield* store.takeOver(first)
				assert.equal(
					(yield* commands
						.complete(first, { ref: "sandbox" })
						.pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
				yield* work(next)
				assert.equal(
					(yield* active.row(key.namespace, state.resource.id)).pipe(
						Option.getOrThrow,
					).state,
					"paused",
				)
				const db = yield* Db.make
				assert.equal(
					(yield* db
						.select()
						.from(computerUsage)
						.where(eq(computerUsage.organizationId, key.namespace))).length,
					1,
				)
			}),
	)
	it.effect(
		"a sent Computer action stays unknown and does not send after takeover",
		() =>
			Effect.gen(function* () {
				const { commands, identity, work } = yield* setup("computer-unknown")
				const store = yield* Store.Store
				const receipt = yield* create(commands, identity)
				const key = {
					namespace: identity.owner.organizationId,
					id: receipt.executionId,
				}
				const old = yield* store.takeOver(key)
				const saved = yield* commands.load(key)
				const call = yield* store.writeAttempt(old, "Create", {
					computer: saved.input.computer.id,
				})
				yield* store.sending(old, call.id)
				const next = yield* store.takeOver(key)
				const before = yield* Ref.get(yield* Sends)
				yield* work(next)
				assert.deepStrictEqual(yield* Ref.get(yield* Sends), before)
				assert.equal((yield* store.get(key)).status, "outcome_unknown")
				assert.equal(
					yield* store.finishCall(
						old,
						call.id,
						{ ref: "late-sandbox" },
						undefined,
						commands.remember(old, { ref: "late-sandbox" }),
					),
					false,
				)
				assert.equal(
					(yield* (yield* Activity.make).row(
						key.namespace,
						saved.input.computer.id,
					)).pipe(Option.getOrThrow).ref,
					"late-sandbox",
				)
				assert.equal(
					(yield* (yield* Activity.make).row(
						key.namespace,
						saved.input.computer.id,
					)).pipe(Option.getOrThrow).state,
					"starting",
				)
				yield* (yield* Calls.Calls).recover(next, call.id)
				yield* work(next)
				assert.equal((yield* store.get(key)).status, "completed")
			}),
	)
	it.effect(
		"idle work has one saved owner and current read and decision rights",
		() =>
			Effect.gen(function* () {
				const { commands, maintenance, identity, work } =
					yield* setup("computer-idle")
				const store = yield* Store.Store
				const receipt = yield* create(commands, identity)
				const key = {
					namespace: identity.owner.organizationId,
					id: receipt.executionId,
				}
				yield* work(yield* store.takeOver(key))
				const id = (yield* store.get(key)).resource.id
				const db = yield* Db.make
				yield* db
					.update(computers)
					.set({ lastActiveAt: 0 })
					.where(Activity.where(key.namespace, id))
				yield* Effect.all([maintenance.bootstrap, maintenance.bootstrap], {
					concurrency: 2,
				})
				const sweepRows = yield* db
					.select()
					.from(executions)
					.where(eq(executions.workflow, Maintenance.sweepWorkflowName))
				assert.equal(sweepRows.length, 1)
				const sweepKey = {
					namespace: Maintenance.sweepNamespace,
					id: Execution.Id.make(sweepRows[0]!.id),
				}
				yield* maintenance.sweep(yield* store.takeOver(sweepKey))
				const rows = yield* db
					.select()
					.from(executions)
					.where(
						and(
							eq(executions.workflow, Activity.pauseWorkflowName),
							eq(executions.namespace, key.namespace),
						),
					)
				assert.equal(rows.length, 1)
				const pauseKey = {
					namespace: key.namespace,
					id: Execution.Id.make(rows[0]!.id),
				}
				yield* maintenance.publicAccess(pauseKey, identity.actor, "read")
				assert.equal(
					(yield* maintenance
						.publicAccess(pauseKey, caller("another-account"), "read")
						.pipe(Effect.flip))._tag,
					"ExecutionForbidden",
				)
				const fence = yield* store.takeOver(pauseKey)
				const call = yield* store.writeAttempt(fence, "pause", { computer: id })
				const outcome = yield* (yield* Calls.Calls).invoke(fence, call, () =>
					Effect.fail(
						ComputerCallFailed.make({
							message: "The pause reply was lost.",
							retry: false,
						}),
					),
				)
				assert.equal(outcome._tag, "Unknown")
				const decisionId = Execution.callDecisionId(call.id, 0)
				assert.equal(
					(yield* maintenance
						.decide(pauseKey, identity.actor, {
							commandKey: Execution.CommandKey.make("bad-retry"),
							decisionId,
							answer: "retry",
						})
						.pipe(Effect.flip))._tag,
					"ExecutionForbidden",
				)
				yield* Ref.set(yield* Allowed, false)
				assert.equal(
					(yield* maintenance
						.publicAccess(pauseKey, identity.actor, "decide")
						.pipe(Effect.flip))._tag,
					"ExecutionNotFound",
				)
				yield* Ref.set(yield* Allowed, true)
				const decision = {
					commandKey: Execution.CommandKey.make("stop"),
					decisionId,
					answer: "stop" as const,
				}
				assert.deepStrictEqual(
					yield* maintenance.decide(pauseKey, identity.actor, decision),
					yield* maintenance.decide(pauseKey, identity.actor, decision),
				)
				yield* maintenance.finish(fence, { status: "interrupted" })
				assert.equal(
					(yield* (yield* Activity.make).row(key.namespace, id)).pipe(
						Option.getOrThrow,
					).state,
					"failed",
				)
				assert.equal((yield* store.get(pauseKey)).status, "interrupted")
			}),
	)
	it.effect(
		"a confirmed create kept at an interrupted boundary keeps its resource and use",
		() =>
			Effect.gen(function* () {
				const { commands, identity } = yield* setup("computer-finish")
				const store = yield* Store.Store
				const receipt = yield* create(commands, identity)
				const fence = yield* store.takeOver({
					namespace: identity.owner.organizationId,
					id: receipt.executionId,
				})
				const { input } = yield* commands.load(fence)
				const call = yield* store.writeAttempt(fence, "Create", {
					computer: input.computer.id,
				})
				yield* store.sending(fence, call.id)
				yield* store.finishCall(
					fence,
					call.id,
					{ ref: "saved-box" },
					undefined,
					commands.remember(fence, { ref: "saved-box" }),
				)
				yield* commands.finish(fence, { status: "interrupted" })
				const row = (yield* (yield* Activity.make).row(
					fence.namespace,
					input.computer.id,
				)).pipe(Option.getOrThrow)
				assert.equal(row.ref, "saved-box")
				assert.equal(row.state, "failed")
				const db = yield* Db.make
				const use = yield* db
					.select()
					.from(computerUsage)
					.where(eq(computerUsage.organizationId, fence.namespace))
				assert.equal(use.length, 1)
				assert.equal(use[0]!.endedAt, null)
				assert.equal((yield* store.get(fence)).status, "interrupted")
			}),
	)
	it.effect(
		"the saved Computer caller must still be allowed before a send",
		() =>
			Effect.gen(function* () {
				const { commands, identity, work } = yield* setup("computer-revoked")
				const store = yield* Store.Store
				const receipt = yield* create(commands, identity)
				const fence = yield* store.takeOver({
					namespace: identity.owner.organizationId,
					id: receipt.executionId,
				})
				yield* Ref.set(yield* Allowed, false)
				const before = yield* Ref.get(yield* Sends)
				assert.ok(
					Schema.is(Execution.Forbidden)(yield* work(fence).pipe(Effect.flip)),
				)
				assert.deepStrictEqual(yield* Ref.get(yield* Sends), before)
				yield* Ref.set(yield* Allowed, true)
			}),
	)
})
