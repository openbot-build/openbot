import { PgClient } from "@effect/sql-pg"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Config, Effect, Layer, Option, String as Str } from "effect"
import { Command, Flag } from "effect/cli"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import { Settings as Api } from "@openbot-build/api"
import * as OpenBot from "./OpenBot.ts"

const publicOrigin = Flag.String("public-origin").pipe(
	Flag.withSchema(Api.PublicOrigin),
	Flag.withDescription("The public HTTPS address of OpenBot."),
)
const issuer = Flag.String("oidc-issuer").pipe(
	Flag.withSchema(Api.Issuer),
	Flag.optional,
	Flag.withDescription(
		"The OpenID Connect provider of the platform. Leave it out when people sign in only through organization SSO.",
	),
)
const clientId = Flag.String("oidc-client-id").pipe(
	Flag.optional,
	Flag.withDescription("The client ID at the OpenID Connect provider."),
)
const clientSecret = Flag.Redacted("oidc-client-secret").pipe(
	// A secret on the command line can show up in process lists, so it can also come from the environment.
	Flag.withFallbackConfig(Config.Redacted("OPENBOT_SETUP_OIDC_CLIENT_SECRET")),
	Flag.optional,
	Flag.withDescription(
		"The client secret. Leave it out for a public PKCE client. You can also set OPENBOT_SETUP_OIDC_CLIENT_SECRET.",
	),
)
const adminEmails = Flag.String("admin-email").pipe(
	Flag.atLeast(1),
	Flag.withDescription(
		"A person with this verified email becomes a platform admin. Repeat it for more people.",
	),
)
const adminProvider = Flag.String("admin-provider").pipe(
	Flag.withDefault("oidc"),
	Flag.withDescription(
		"The provider that must verify admin emails: oidc, email, or an SSO connection ID.",
	),
)

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
	publicOrigin,
	issuer,
	clientId,
	clientSecret,
	adminEmails,
	adminProvider,
	force,
}).pipe(
	Command.withDescription(
		"Write the first platform settings and platform admins. Change them later through /v1/platform.",
	),
	Command.withHandler((input) =>
		Effect.gen(function* () {
			if (Option.isSome(input.issuer) !== Option.isSome(input.clientId))
				return yield* Setup.SetupInvalid.make({
					message: "Set --oidc-issuer and --oidc-client-id together.",
				})
			const identityProvider = Option.zipWith(
				input.issuer,
				input.clientId,
				(issuer, clientId) => ({
					issuer,
					clientId,
					clientSecret: input.clientSecret,
				}),
			)
			const outcome = yield* Setup.run({
				publicOrigin: input.publicOrigin,
				identityProvider,
				adminEmails: input.adminEmails,
				adminProvider: input.adminProvider,
				fileStorage: Option.none(),
				force: input.force,
				authSecret: Option.none(),
			})
			if (input.force) {
				const sql = yield* PgClient.PgClient
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`select pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`
						for (const email of input.adminEmails) {
							const rows = yield* sql<{
								id: string
							}>`select u.id from openbot_auth_user u join openbot_auth_account a on a.user_id=u.id where lower(u.email)=${Str.toLowerCase(email)} and a.provider_id=${input.adminProvider} and u.email_verified=true`
							for (const row of rows) {
								yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-access:" + row.id}, 0))`
								yield* sql`delete from openbot_auth_session where user_id=${row.id}`
								yield* sql`delete from openbot_tokens where user_id=${row.id}`
								yield* sql`insert into openbot_account_states (user_id,status,revoked_at) values (${row.id},'active',(extract(epoch from clock_timestamp())*1000)::bigint) on conflict(user_id) do update set status='active',revoked_at=excluded.revoked_at`
								yield* sql`update openbot_platform_admins set user_id=${row.id},provider_id=${input.adminProvider} where email=${Str.toLowerCase(email)}`
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
