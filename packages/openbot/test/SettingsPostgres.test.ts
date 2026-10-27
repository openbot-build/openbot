import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Logger,
	type Pull,
	Redacted,
	References,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import { organizationScope, type Scope } from "../src/settings/Documents.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as SettingsPostgres from "../src/settings/SettingsPostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as ErrorRecords from "../src/errors/Records.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"

/** Starts a new database, and gives the layer of a connection pool to it. */
const startDatabase = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const databaseLayer = DatabasePostgres.layer({
		databaseUrl: Redacted.make(database.url),
	})
	// The migration has its own database pool. It closes after the migration.
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	return databaseLayer
})

/**
 * Starts one OpenBot instance on the database. A new memo map builds every
 * layer again, as in a new process.
 */
const startInstance = (
	databaseLayer: ReturnType<typeof DatabasePostgres.layer>,
) =>
	Effect.gen(function* () {
		const services = yield* Layer.buildWithMemoMap(
			SettingsPostgres.layer.pipe(
				Layer.provide(ErrorRecords.layer),
				Layer.provideMerge(
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
				),
				Layer.provideMerge(databaseLayer),
			),
			yield* Layer.makeMemoMap,
			yield* Effect.scope,
		)
		return {
			settings: Context.get(services, Settings),
			sql: Context.get(services, PgClient.PgClient),
			secrets: Context.get(services, Secrets.Secrets),
		}
	})

const isOrganization = (id: string) => (scope: Scope) =>
	scope.kind === "organization" && scope.id === id

/** Reads the organization settings again and again until their version is not 0. */
const changed = (settings: Settings["Service"], organizationId: string) =>
	settings.organization(organizationId).pipe(
		Effect.repeat({
			until: (snapshot) => snapshot.version !== 0,
			schedule: Schedule.spaced("20 millis"),
			times: 250,
		}),
	)

/** Waits for the first change of an organization on one instance. */
const heard = (settings: Settings["Service"], organizationId: string) =>
	settings.changes.pipe(
		Stream.filter(isOrganization(organizationId)),
		Stream.runHead,
	)

/**
 * Sends a notice again and again until `listener` ends. A new subscription
 * does not start at once, so the first notices can come before it.
 */
const untilHeard = <A, E, R>(
	listener: Effect.Effect<A, E, R>,
	settings: Settings["Service"],
	organizationId: string,
) =>
	Effect.raceFirst(
		listener,
		settings
			.notify(organizationScope(organizationId))
			.pipe(
				Effect.repeat(Schedule.spaced("100 millis")),
				Effect.andThen(Effect.never),
			),
	).pipe(Effect.timeout("10 seconds"))

/** Takes changes from a subscription until one of them passes `last`. */
const takeUntil = <E>(
	pull: Pull.Pull<ReadonlyArray<Scope>, E>,
	last: (scope: Scope) => boolean,
	received: ReadonlyArray<Scope> = [],
): Effect.Effect<ReadonlyArray<Scope>, E | Cause.Done<void>> =>
	Effect.flatMap(pull, (chunk) => {
		const next = Arr.appendAll(received, chunk)
		return Arr.some(chunk, last)
			? Effect.succeed(next)
			: takeUntil(pull, last, next)
	})

it.live("a missed settings notice does not keep old rights", () =>
	Effect.gen(function* () {
		const database = yield* startDatabase
		const first = yield* startInstance(database)
		const second = yield* startInstance(database)
		yield* first.settings.updateOrganization("silent", 0, (document) =>
			Effect.succeed(document),
		)
		assert.strictEqual(
			(yield* second.settings.organization("silent")).document.botMemory,
			true,
		)
		// This direct write sends no pg_notify. The next read must still see it.
		yield* first.sql`UPDATE openbot_settings SET document = jsonb_set(document::jsonb, '{botMemory}', 'false')::text, version = version + 1 WHERE scope_kind = 'organization' AND scope_id = 'silent'`
		assert.strictEqual(
			(yield* second.settings.organization("silent")).document.botMemory,
			false,
		)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

// The database is real, so the tests use real time.
it.live(
	"the settings listener seals a broken connection, listens again, and then gets every notice",
	() => {
		let warnings: ReadonlyArray<{
			readonly message: unknown
			readonly cause: Cause.Cause<unknown>
			readonly operation: unknown
			readonly errorId: unknown
		}> = []
		const logs = Logger.layer([
			Logger.make((log) => {
				if (log.logLevel === "Error") {
					const annotations = log.fiber.getRef(References.CurrentLogAnnotations)
					warnings = [
						...warnings,
						{
							message: log.message,
							cause: log.cause,
							operation: annotations["operation"],
							errorId: annotations["errorId"],
						},
					]
				}
			}),
		])
		return Effect.gen(function* () {
			const database = yield* startDatabase
			const first = yield* startInstance(database)
			const second = yield* startInstance(database)
			// Each listener is up when its instance hears a notice.
			yield* untilHeard(
				heard(first.settings, "org_up"),
				first.settings,
				"org_up",
			)
			yield* untilHeard(
				heard(second.settings, "org_up"),
				first.settings,
				"org_up",
			)
			const listeners = yield* first.sql<{
				readonly stopped: boolean
			}>`SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE query = ${`LISTEN "${SettingsPostgres.channel}"`}`
			assert.strictEqual(listeners.length, 2)
			// An instance hears a notice again only after its listener starts again.
			yield* untilHeard(
				heard(first.settings, "org_back"),
				first.settings,
				"org_back",
			)
			yield* untilHeard(
				heard(second.settings, "org_back"),
				first.settings,
				"org_back",
			)
			const stopped = Arr.filter(
				warnings,
				(warning) =>
					warning.operation ===
					"The settings listener stopped. It starts again.",
			)
			assert.strictEqual(stopped.length, 2)
			assert.ok(
				Arr.every(stopped, (warning) => warning.cause.reasons.length === 0),
			)
			assert.ok(
				Arr.every(stopped, (warning) => typeof warning.errorId === "string"),
			)
			assert.ok(
				Arr.every(
					stopped,
					(warning) =>
						Arr.isArray(warning.message) &&
						warning.message[0] ===
							"An operation failed. Its cause is in the sealed error record.",
				),
			)
			const records = yield* first.sql<{
				readonly id: string
				readonly cause: string
			}>`SELECT id, cause FROM openbot_execution_failures`
			assert.strictEqual(records.length, 2)
			for (const record of records) {
				const retained = yield* first.secrets.open(
					record.cause,
					`failure:${record.id}`,
				)
				assert.include(retained, '"kind":"Fail"')
				assert.notInclude(record.cause, "SqlError")
			}

			// Reads see the committed change on both instances.
			assert.strictEqual(
				(yield* second.settings.organization("org_after")).version,
				0,
			)
			yield* first.settings.updateOrganization("org_after", 0, (document) =>
				Effect.succeed({ ...document, botMemory: false }),
			)
			const seen = yield* changed(second.settings, "org_after")
			assert.strictEqual(seen.version, 1)
			assert.strictEqual(seen.document.botMemory, false)
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, logs)),
		)
	},
	{ timeout: 60000 },
)

it.live(
	"a failed settings read keeps its private cause and is not cached",
	() => {
		let warnings: ReadonlyArray<{
			readonly message: unknown
			readonly scope: unknown
		}> = []
		const logs = Logger.layer([
			Logger.make((log) => {
				if (log.logLevel === "Warn" || log.logLevel === "Error")
					warnings = [
						...warnings,
						{
							message: log.message,
							scope: log.fiber.getRef(References.CurrentLogAnnotations)[
								"settingsScope"
							],
						},
					]
			}),
		])
		return Effect.gen(function* () {
			const database = yield* startDatabase
			const instance = yield* startInstance(database)
			// Wait for the change subscription to start.
			yield* untilHeard(
				heard(instance.settings, "org_up"),
				instance.settings,
				"org_up",
			)
			yield* instance.sql`INSERT INTO openbot_settings (scope_kind, scope_id, document, version, updated_at) VALUES ('organization', 'org_bad', 'private-bad-settings', 1, 0)`
			const failed = yield* Effect.flip(
				instance.settings.organization("org_bad"),
			)
			assert.strictEqual(failed._tag, "SettingsUnavailable")
			assert.deepStrictEqual(warnings, [])
			const retained = yield* Cause.fail(failed).pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			// The parser omits the bad input. Its full error still keeps the expected format.
			assert.include(retained, "SchemaError")
			assert.include(retained, "Expected a valid JSON string")
			// The bad row goes, and no notice says so. The next read does not get the old failure.
			yield* instance.sql`DELETE FROM openbot_settings WHERE scope_kind = 'organization' AND scope_id = 'org_bad'`
			assert.strictEqual(
				(yield* instance.settings.organization("org_bad")).version,
				0,
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, logs)),
		)
	},
	{ timeout: 60000 },
)

it.live(
	"a slow subscriber of the settings changes loses its oldest changes, and the listener does not wait for it",
	() =>
		Effect.gen(function* () {
			const database = yield* startDatabase
			const first = yield* startInstance(database)
			const second = yield* startInstance(database)
			// This subscriber takes its first change, and then nothing while the other changes come.
			const slow = yield* Stream.toPull(second.settings.changes)
			yield* untilHeard(slow, first.settings, "org_start")
			// The listener is up now. Read the initial state.
			assert.strictEqual(
				(yield* second.settings.organization("org_last")).version,
				0,
			)
			const total = SettingsPostgres.changesCapacity * 2
			yield* Effect.forEach(
				Arr.range(1, total),
				(n) => first.settings.notify(organizationScope("org_" + n)),
				{ discard: true },
			)
			yield* first.settings.updateOrganization("org_last", 0, (document) =>
				Effect.succeed({ ...document, botMemory: false }),
			)
			// The second instance reads the last change in time, so its listener did not wait.
			assert.strictEqual(
				(yield* changed(second.settings, "org_last")).version,
				1,
			)
			const received = yield* takeUntil(slow, isOrganization("org_last")).pipe(
				Effect.timeout("10 seconds"),
			)
			assert.ok(received.length >= SettingsPostgres.changesCapacity)
			assert.ok(received.length <= SettingsPostgres.changesCapacity + 1)
			assert.ok(!Arr.some(received, isOrganization("org_1")))
			assert.ok(Arr.some(received, isOrganization("org_" + total)))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
