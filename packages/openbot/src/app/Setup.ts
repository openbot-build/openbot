import { PgClient } from "@effect/sql-pg"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import {
	Config,
	Effect,
	Layer,
	Option,
	FileSystem,
	String as Str,
} from "effect"
import { Command, Flag } from "effect/cli"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import { read } from "../platform/SetupFile.ts"
import * as OpenBot from "./OpenBot.ts"

const force = Flag.Boolean("force").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Write the settings even when they exist. Use it only when no platform admin can sign in.",
	),
)

const services = Layer.unwrap(
	Effect.map(
		Config.all({
			databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
			secretKeys: Config.Redacted("OPENBOT_SECRET_KEYS"),
		}),
		(instance) =>
			PlatformAdminsPostgres.layer.pipe(
				Layer.provideMerge(OpenBot.layerShared(instance)),
			),
	),
)

/** What the command says after each outcome of setup. */
const done: Record<Setup.Outcome, string> = {
	created: "OpenBot wrote the platform settings.",
	replaced: "OpenBot replaced the platform settings.",
	unchanged:
		"The platform settings were already the same. OpenBot added the admins.",
}

// Read the settings only when the command runs, so --help works without them.
const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(
			services.pipe(
				// The database URL and the secret keys may come from secret files.
				// The program gives the Node services that read the files.
				Layer.provide(SecretFiles.layer()),
			),
		),
	)

const setup = Command.make("openbot setup", {
	config: Flag.String("config").pipe(
		Flag.withDescription(
			"A private JSON file with the first platform settings and admins.",
		),
	),
	force,
}).pipe(
	Command.withDescription(
		"Write the first platform settings and platform admins. Change them later through /v1/platform.",
	),
	Command.withHandler((input) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const settings = yield* read(fs, input.config)
			const outcome = yield* Setup.run({
				...settings,
				force: input.force,
				authSecret: Option.none(),
			})
			if (input.force) {
				const sql = yield* PgClient.PgClient
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`select pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`
						for (const email of settings.adminEmails) {
							const rows = yield* sql<{
								id: string
							}>`select u.id from openbot_auth_user u join openbot_auth_account a on a.user_id=u.id where lower(u.email)=${Str.toLowerCase(email)} and a.provider_id=${settings.adminProvider} and u.email_verified=true`
							for (const row of rows) {
								yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-access:" + row.id}, 0))`
								yield* sql`delete from openbot_auth_session where user_id=${row.id}`
								yield* sql`delete from openbot_tokens where user_id=${row.id}`
								yield* sql`insert into openbot_account_states (user_id,status,revoked_at) values (${row.id},'active',(extract(epoch from clock_timestamp())*1000)::bigint) on conflict(user_id) do update set status='active',revoked_at=excluded.revoked_at`
								yield* sql`update openbot_platform_admins set user_id=${row.id},provider_id=${settings.adminProvider} where email=${Str.toLowerCase(email)}`
								yield* sql`insert into openbot_access_events (id,action,actor,subject,created_at) values (gen_random_uuid()::text,'admin.recovered','server-command',${row.id},(extract(epoch from clock_timestamp())*1000)::bigint)`
							}
						}
					}),
				)
			}
			yield* Effect.logInfo(done[outcome])
		}).pipe(
			Effect.catchTag("SetupAlreadyDone", () =>
				Effect.fail(
					Setup.SetupInvalid.make({
						message:
							"The platform already has other settings. Change them through PATCH /v1/platform/settings, or run setup again with --force.",
					}),
				),
			),
			withServices,
		),
	),
)

const program = Command.run(setup, { version: "0.1.0" })

NodeRuntime.runMain(
	program.pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(NodeServices.layer),
	),
)
