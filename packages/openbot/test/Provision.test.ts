import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Redacted,
	Schema,
	Stream,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as Provision from "../src/platform/Provision.ts"
import { Organization } from "../src/organization/Organization.ts"
import { Bots } from "../src/bots/Bots.ts"
import { Settings } from "../src/settings/Settings.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import { bindings } from "../src/settings/Platform.ts"
import { ModelProviders, platformOwner } from "../src/models/ModelProviders.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const example = {
	version: 1,
	platform: {
		publicOrigin: "https://workspace.example.com",
		browserAuth: {
			sessionCookie: "__Host-workspace_session",
			loginCookie: "__Host-workspace_login",
			sessionTtlMs: 86400000,
		},
		identityProvider: {
			providerId: "company",
			issuer: "https://id.example.com",
			clientId: "workspace",
			clientSecret: "private-provider-secret",
			callbackPath: "/auth/callback",
			scopes: ["openid", "profile", "email", "offline_access"],
		},
		authSecret: "private-auth-secret-kept-from-the-source",
		fileStorage: {
			endpoint: "http://storage:9000",
			publicEndpoint: null,
			region: "us-east-1",
			bucket: "workspace-files",
			accessKeyId: "workspace-storage",
			secretAccessKey: "private-storage-key",
			forcePathStyle: true,
		},
	},
	organization: {
		name: "Example",
		ownerUserId: "owner",
		allowNewAccounts: true,
	},
	users: [
		{
			id: "owner",
			name: "Owner",
			email: "owner@example.com",
			emailVerified: true,
			accounts: [
				{
					id: "account-owner",
					subject: "subject-owner",
					providerId: "company",
				},
			],
		},
		{
			id: "member",
			name: "Member",
			email: "member@example.com",
			emailVerified: true,
			accounts: [
				{
					id: "account-member",
					subject: "subject-member",
					providerId: "company",
				},
			],
		},
	],
	bot: {
		name: "Assistant",
		role: "Personal assistant",
		instructions: "Help the person with their work.",
	},
	models: [
		{
			id: "language-test",
			name: "Language",
			reasoningEfforts: [],
			serviceTiers: [],
		},
	],
	providers: [
		{
			name: "Company",
			kind: "openai-compat",
			endpoint: "https://models.example.com/v1",
			apiKey: "private-model-key",
			models: [{ model: "language-test", modelOwner: "platform" }],
		},
	],
	defaultModel: { providerName: "Company", modelId: "language-test" },
}
const input = Schema.decodeUnknownEffect(Provision.Input)(example, {
	onExcessProperty: "error",
})

const start = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const connection = { databaseUrl: Redacted.make(database.url) }
	yield* DatabasePostgres.migrate.pipe(
		Effect.provide(DatabasePostgres.layer(connection)),
	)
	return yield* Layer.build(
		Provision.layer.pipe(
			Layer.provideMerge(
				OpenBot.layerShared({
					...connection,
					secretKeys: Redacted.make(
						"test:1111111111111111111111111111111111111111111111111111111111111111",
					),
				}),
			),
		),
	)
})

it.live(
	"sets up stable sign-in links and private default Bots once",
	() =>
		Effect.gen(function* () {
			const context = yield* start
			const value = yield* input
			const first = yield* Provision.run(value).pipe(Effect.provide(context))
			assert.equal(first.outcome, "created")
			const second = yield* Provision.run(value).pipe(Effect.provide(context))
			assert.deepEqual(second, { ...first, outcome: "unchanged" })
			assert.equal(
				Arr.dedupe(Arr.map(first.users, (user) => user.botId)).length,
				2,
			)
			const sql = Context.get(context, PgClient.PgClient)
			assert.deepEqual(
				yield* sql`SELECT id,account_id,provider_id,user_id,access_token,refresh_token FROM openbot_auth_account ORDER BY id`,
				[
					{
						id: "account-member",
						account_id: "subject-member",
						provider_id: "company",
						user_id: "member",
						access_token: null,
						refresh_token: null,
					},
					{
						id: "account-owner",
						account_id: "subject-owner",
						provider_id: "company",
						user_id: "owner",
						access_token: null,
						refresh_token: null,
					},
				],
			)
			assert.equal((yield* sql`SELECT 1 FROM openbot_auth_session`).length, 0)
			assert.equal((yield* sql`SELECT 1 FROM openbot_chats`).length, 0)
			const org = Context.get(context, Organization)
			const members = yield* org.listMembers(first.organizationId, {
				limit: 100,
			})
			assert.deepEqual(
				Option.getOrThrow(
					Arr.findFirst(members.items, (member) => member.userId === "owner"),
				).roles,
				["super_administrator"],
			)
			assert.deepEqual(
				Option.getOrThrow(
					Arr.findFirst(members.items, (member) => member.userId === "member"),
				).roles,
				["member"],
			)
			const settings = Context.get(context, Settings)
			for (const user of first.users) {
				const saved = yield* settings.member(first.organizationId, user.userId)
				assert.equal(saved.document.defaultBot, user.botId)
				assert.equal(saved.version, 1)
			}
			const platform = Option.getOrThrow(yield* settings.platform).document
			assert.equal(platform.memberSignupOrganizationId, first.organizationId)
			const secrets = Context.get(context, Secrets)
			assert.equal(
				yield* secrets.open(platform.authSecret, bindings.authSecret),
				example.platform.authSecret,
			)
			assert.equal(
				yield* secrets.open(
					platform.identityProvider!.clientSecret!,
					bindings.identityProviderSecret,
				),
				example.platform.identityProvider.clientSecret,
			)
			const providers = Context.get(context, ModelProviders)
			const provider = Option.getOrThrow(
				yield* providers.get(platformOwner, first.providers[0]!.providerId),
			)
			assert.equal(
				Redacted.value(yield* providers.openKey(provider)),
				example.providers[0]!.apiKey,
			)
			assert.deepEqual(provider.availability, {
				_tag: "Selected",
				organizations: [first.organizationId],
			})
			const ownerBot = first.users[0]!.botId
			const denied = yield* Context.get(context, Bots)
				.access(
					{
						kind: "member",
						organizationId: first.organizationId,
						userId: "member",
					},
					ownerBot,
					"read",
				)
				.pipe(Effect.exit)
			assert.equal(denied._tag, "Failure")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

it.live(
	"rolls back identity and settings when a later native provider check fails",
	() =>
		Effect.gen(function* () {
			const context = yield* start
			const value = yield* input
			const invalid = {
				...value,
				providers: Arr.map(value.providers, (provider) => ({
					...provider,
					kind: "typesafe" as const,
				})),
			}
			assert.equal(
				(yield* Provision.run(invalid).pipe(
					Effect.provide(context),
					Effect.exit,
				))._tag,
				"Failure",
			)
			const sql = Context.get(context, PgClient.PgClient)
			for (const table of [
				"openbot_auth_user",
				"openbot_organizations",
				"openbot_settings",
				"openbot_models",
				"openbot_provisions",
			])
				assert.equal((yield* sql`SELECT 1 FROM ${sql(table)}`).length, 0)
			assert.equal(
				(yield* Provision.run(value).pipe(Effect.provide(context))).outcome,
				"created",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

it.live(
	"rejects any pre-existing target rows and preserves them",
	() =>
		Effect.gen(function* () {
			const context = yield* start
			const sql = Context.get(context, PgClient.PgClient)
			yield* sql`INSERT INTO openbot_auth_user(id,name,email) VALUES('other','Other','other@example.com')`
			assert.equal(
				(yield* Provision.run(yield* input).pipe(
					Effect.provide(context),
					Effect.exit,
				))._tag,
				"Failure",
			)
			assert.deepEqual(yield* sql`SELECT id FROM openbot_auth_user`, [
				{ id: "other" },
			])
			assert.equal((yield* sql`SELECT 1 FROM openbot_provisions`).length, 0)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

it.live(
	"checks both the manifest and saved data before an unchanged replay",
	() =>
		Effect.gen(function* () {
			const context = yield* start
			const value = yield* input
			yield* Provision.run(value).pipe(Effect.provide(context))
			assert.equal(
				(yield* Provision.run({
					...value,
					bot: { ...value.bot, name: "Another" },
				}).pipe(Effect.provide(context), Effect.exit))._tag,
				"Failure",
			)
			const sql = Context.get(context, PgClient.PgClient)
			yield* sql`UPDATE openbot_auth_user SET name='Changed' WHERE id='member'`
			assert.equal(
				(yield* Provision.run(value).pipe(Effect.provide(context), Effect.exit))
					._tag,
				"Failure",
			)
			assert.deepEqual(
				yield* sql`SELECT name FROM openbot_auth_user WHERE id='member'`,
				[{ name: "Changed" }],
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

it.live(
	"serializes two setup calls without creating duplicate Bots",
	() =>
		Effect.gen(function* () {
			const context = yield* start
			const value = yield* input
			const results = yield* Effect.all(
				[Provision.run(value), Provision.run(value)],
				{ concurrency: 2 },
			).pipe(Effect.provide(context))
			assert.deepEqual(
				Arr.sort(
					Arr.map(results, (result) => result.outcome),
					Order.String,
				),
				["created", "unchanged"],
			)
			assert.equal(results[0]!.organizationId, results[1]!.organizationId)
			assert.deepEqual(results[0]!.users, results[1]!.users)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

it.effect("rejects duplicate subjects and extra token fields", () =>
	Effect.gen(function* () {
		const value = yield* input
		const duplicate = {
			...value,
			users: Arr.map(value.users, (user) => ({
				...user,
				accounts: Arr.map(user.accounts, (account) => ({
					...account,
					subject: "same",
				})),
			})),
		}
		assert.equal(
			(yield* Provision.validate(duplicate).pipe(Effect.exit))._tag,
			"Failure",
		)
		const extra = {
			...example,
			users: Arr.map(example.users, (user) => ({
				...user,
				token: "do-not-import",
			})),
		}
		assert.equal(
			(yield* Schema.decodeUnknownEffect(Provision.Input)(extra, {
				onExcessProperty: "error",
			}).pipe(Effect.exit))._tag,
			"Failure",
		)
	}),
)

it.live(
	"the built command checks private input and never prints its secrets",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			yield* DatabasePostgres.migrate.pipe(
				Effect.provide(
					DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
				),
			)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* fs.makeTempDirectoryScoped({
				prefix: "openbot-provision-command-",
			})
			const inputPath = path.join(directory, "input.json")
			yield* fs.writeFileString(
				inputPath,
				yield* Schema.encodeEffect(Schema.fromJsonString(Provision.Input))(
					yield* input,
				),
			)
			yield* fs.chmod(inputPath, 0o600)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const invoke = () =>
				Effect.gen(function* () {
					const process = yield* spawner.spawn(
						ChildProcess.make(
							"node",
							[
								new URL("../dist/Provision.js", import.meta.url).pathname,
								"--input",
								inputPath,
							],
							{
								env: {
									OPENBOT_DATABASE_URL: database.url,
									OPENBOT_SECRET_KEYS:
										"test:1111111111111111111111111111111111111111111111111111111111111111",
								},
								extendEnv: true,
								stdin: "ignore",
								stdout: "pipe",
								stderr: "pipe",
							},
						),
					)
					const output = Arr.join(
						yield* process.all.pipe(Stream.decodeText, Stream.runCollect),
						"",
					)
					return { output, code: yield* process.exitCode }
				})
			const created = yield* invoke()
			assert.equal(created.code, 0)
			assert.equal(
				(yield* Schema.decodeEffect(Schema.fromJsonString(Provision.Result))(
					Str.trim(created.output),
				)).outcome,
				"created",
			)
			const replay = yield* invoke()
			assert.equal(replay.code, 0)
			assert.equal(
				(yield* Schema.decodeEffect(Schema.fromJsonString(Provision.Result))(
					Str.trim(replay.output),
				)).outcome,
				"unchanged",
			)
			yield* fs.chmod(inputPath, 0o644)
			const publicFile = yield* invoke()
			assert.notEqual(publicFile.code, 0)
			yield* fs.chmod(inputPath, 0o600)
			yield* fs.writeFileString(
				inputPath,
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
					...example,
					version: "private-marker-that-must-not-be-logged",
				}),
			)
			const invalid = yield* invoke()
			assert.notEqual(invalid.code, 0)
			for (const output of [
				created.output,
				replay.output,
				publicFile.output,
				invalid.output,
			])
				for (const secret of [
					example.platform.identityProvider.clientSecret,
					example.platform.authSecret,
					example.platform.fileStorage.secretAccessKey,
					example.providers[0]!.apiKey,
					"private-marker-that-must-not-be-logged",
				])
					assert.equal(Str.includes(secret)(output), false)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)
