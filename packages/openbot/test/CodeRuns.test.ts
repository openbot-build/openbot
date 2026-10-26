import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	type Caller,
	ChatConflict,
	CodeRunsApi,
	Settings as SettingsApi,
	VaultsApi,
} from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import { Clock, Effect, Layer, Option, Redacted, String as Str } from "effect"
import { ActionPolicy } from "../src/apps/ActionPolicy.ts"
import { Capabilities } from "../src/apps/Capabilities.ts"
import { Invocations } from "../src/apps/Invocations.ts"
import { Gate } from "../src/capabilities/Gate.ts"
import { Work } from "../src/capabilities/Work.ts"
import * as CodeRuns from "../src/code/CodeRuns.ts"
import * as Sandbox from "../src/code/Sandbox.ts"
import * as Stored from "../src/code/StoredCodeRuns.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import { Settings } from "../src/settings/Settings.ts"
import type { PlatformDocument } from "../src/settings/Documents.ts"
import { Vaults } from "../src/vaults/Vaults.ts"
import * as BotFixture from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

/** A throwaway PostgreSQL server, the Secrets and the sandbox for the test. */
const TestDatabase = Layer.mergeAll(
	Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	Layer.effect(Sandbox.Sandbox, Sandbox.make),
).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)

const owner = "test-owner"
const position = {
	owner,
	chat: Chat.Id.make("chat_code"),
	turn: Turn.Id.make("turn_code"),
}

const enabled: typeof Settings.Service.platform = Effect.succeedSome({
	// Code Mode reads only its own part of the platform settings.
	document: {
		...({} as PlatformDocument),
		codeMode: { ...SettingsApi.codeModeDefaults, enabled: true },
	},
	version: 1,
	updatedAt: 0,
})
const unreadable: typeof Settings.Service.platform = Effect.fail(
	SettingsApi.SettingsUnavailable.make({}),
)

/** The Code Mode service with test settings and Vault items. A program here makes no App calls. */
const codeRunsWith = (input: {
	readonly platform: typeof Settings.Service.platform
	readonly usable?: typeof Vaults.Service.usable
}) =>
	CodeRuns.make.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(Settings, {
					...({} as typeof Settings.Service),
					platform: input.platform,
				}),
				Layer.succeed(Vaults, {
					...({} as typeof Vaults.Service),
					usable: input.usable ?? (() => Effect.succeed([])),
				}),
				Layer.succeed(Capabilities, {} as typeof Capabilities.Service),
				Layer.succeed(Invocations, {} as typeof Invocations.Service),
				Layer.succeed(ActionPolicy, {} as typeof ActionPolicy.Service),
				Layer.succeed(Gate, {} as typeof Gate.Service),
			),
		),
	)

const caller: Caller = {
	kind: "member",
	organizationId: "test-organization",
	userId: "test-user",
}
/** The Turn of the Bot that the program works for. */
const work = Layer.succeed(Work, {
	...({} as typeof Work.Service),
	caller,
	bot: BotFixture.bot,
})

const start = (codeRuns: typeof CodeRuns.CodeRuns.Service, callId: string) =>
	codeRuns
		.start({
			position,
			callId,
			code: "return 1",
			reason: "The test needs it.",
			bindings: [],
		})
		.pipe(Effect.provide(work))

const read = (callId: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const secrets = yield* Secrets.Secrets
		return yield* Stored.forCall(db, secrets, owner, position.chat, callId)
	})

// The database is a real server, so the test runs on the real clock.
layer(TestDatabase, { excludeTestServices: true, timeout: "60 seconds" })(
	(it) => {
		it.effect(
			"a read failure of the Code Mode settings fails the start and saves no run",
			() =>
				Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const codeRuns = yield* codeRunsWith({ platform: unreadable })
					const failed = yield* start(codeRuns, "call_settings").pipe(
						Effect.flip,
					)
					assert.strictEqual(failed._tag, "ExperienceStorageUnavailable")
					assert.isTrue(Option.isNone(yield* read("call_settings")))
					// The list of tools shows no Code Mode while nobody can read its settings.
					assert.isTrue(Option.isNone(yield* codeRuns.settings))
				}),
		)

		it.effect(
			"a read failure of the settings after a decision keeps the run for the sweep",
			() =>
				Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const db = yield* Db.make
					const secrets = yield* Secrets.Secrets
					const now = yield* Clock.currentTimeMillis
					const waiting: Stored.Run = {
						id: CodeRunsApi.CodeRunId.make("run_waiting"),
						chat: position.chat,
						turn: position.turn,
						callId: "call_waiting",
						status: "Waiting",
						code: "return 1",
						reason: "The test needs it.",
						calls: [],
						result: null,
						createdAt: now,
						updatedAt: now,
						seed: 1,
						clock: now,
						organizationId: caller.organizationId,
						userId: caller.userId,
					}
					yield* Stored.insert(db, secrets, owner, waiting, 0)
					const codeRuns = yield* codeRunsWith({ platform: unreadable })
					const failed = yield* codeRuns
						.resume({ owner, id: waiting.id })
						.pipe(Effect.flip)
					assert.strictEqual(failed._tag, "ExperienceStorageUnavailable")
					// The run is not "Code Mode is off". It runs again when its lease ends.
					const run = yield* read("call_waiting")
					assert.strictEqual(Option.getOrThrow(run).status, "Running")
					assert.isNull(Option.getOrThrow(run).result)
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						readonly lease: string
					}>`select lease_until as lease from openbot_code_runs where id = ${waiting.id}`
					assert.isAbove(Number(rows[0]!.lease), now)
				}),
		)

		it.effect(
			"a read failure of the Vault items ends the run before the program starts",
			() =>
				Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const codeRuns = yield* codeRunsWith({
						platform: enabled,
						usable: () => Effect.fail(VaultsApi.VaultsUnavailable.make({})),
					})
					const run = yield* start(codeRuns, "call_vault")
					assert.strictEqual(run.status, "Failed")
					assert.deepStrictEqual(run.result, {
						_tag: "Failed",
						reason: "Unavailable",
						message: "OpenBot could not read the Vault items of the Bot.",
						logs: [],
					})
					assert.strictEqual(
						Option.getOrThrow(yield* read("call_vault")).status,
						"Failed",
					)
				}),
		)

		it.effect(
			"a host whose lease another host took does not write the run again",
			() =>
				Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const sql = yield* PgClient.PgClient
					const codeRuns = yield* codeRunsWith({
						platform: enabled,
						// Another host takes over the run before the program starts.
						usable: () =>
							sql`update openbot_code_runs set lease_until = lease_until + 1 where call_id = ${"call_lease"}`.pipe(
								Effect.orDie,
								Effect.as([]),
							),
					})
					const failed = yield* start(codeRuns, "call_lease").pipe(Effect.flip)
					assert.deepStrictEqual(
						failed,
						ChatConflict.make({
							message: "Another host runs this code run now.",
						}),
					)
					// The run stays as the other host left it.
					const run = Option.getOrThrow(yield* read("call_lease"))
					assert.strictEqual(run.status, "Running")
					assert.isNull(run.result)
				}),
		)
	},
)
