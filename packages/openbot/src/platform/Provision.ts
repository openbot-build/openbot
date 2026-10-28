import { PgClient } from "@effect/sql-pg"
import {
	Bots as BotsApi,
	Models as ModelProvidersApi,
	Settings as Api,
} from "@openbot-build/domain"
import { Config, Model, Provider } from "@openbot-build/core"
import {
	Array as Arr,
	Crypto,
	Effect,
	Layer,
	Option,
	Order,
	Record,
	Schema,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import * as AuthImport from "../auth/Import.ts"
import * as TokensPostgres from "../auth/TokensPostgres.ts"
import * as AuthorizationLayer from "../authorization/Layer.ts"
import * as RolesPostgres from "../authorization/RolesPostgres.ts"
import * as AuditLogPostgres from "../audit/AuditLogPostgres.ts"
import * as BotRecords from "../bots/BotRecords.ts"
import { Bots, layer as botsLayer } from "../bots/Bots.ts"
import { Models } from "../models/Models.ts"
import * as ModelsPostgres from "../models/ModelsPostgres.ts"
import { ModelProviders, platformOwner } from "../models/ModelProviders.ts"
import * as ModelProvidersPostgres from "../models/ModelProvidersPostgres.ts"
import { Organization } from "../organization/Organization.ts"
import * as OrganizationPostgres from "../organization/OrganizationPostgres.ts"
import { Settings } from "../settings/Settings.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"
import * as PlatformAdminsPostgres from "./PlatformAdminsPostgres.ts"
import * as Setup from "./Setup.ts"

/** Input stays in a private file. The output never includes it or its secrets. */
export const Input = Schema.Struct({
	version: Schema.Literal(1),
	platform: Schema.Struct({
		publicOrigin: Api.PublicOrigin,
		browserAuth: Api.BrowserAuth,
		identityProvider: Schema.Struct({
			providerId: Api.ProviderId,
			issuer: Api.Issuer,
			clientId: Api.ClientId,
			clientSecret: Schema.NullOr(Api.SecretInput),
			callbackPath: Api.CallbackPath,
			scopes: Api.OidcScopes,
		}),
		authSecret: Api.SecretInput,
		fileStorage: Schema.Struct({
			...Api.FileStorageInput.fields,
			secretAccessKey: Api.SecretInput,
		}),
	}),
	organization: Schema.Struct({
		name: Schema.NonEmptyString,
		ownerUserId: Schema.NonEmptyString,
		allowNewAccounts: Schema.Boolean,
	}),
	users: Schema.Array(AuthImport.User).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(1000),
	),
	bot: Schema.Struct({
		name: BotsApi.CreateBotRequest.fields.name,
		role: BotsApi.CreateBotRequest.fields.role,
		instructions: BotsApi.CreateBotRequest.fields.instructions,
	}),
	models: Schema.Array(ModelProvidersApi.CreateModelRequest).check(
		Schema.isMinLength(1),
	),
	providers: Schema.Array(ModelProvidersApi.CreateModelProviderRequest).check(
		Schema.isMinLength(1),
	),
	defaultModel: Schema.Struct({
		providerName: Schema.NonEmptyString,
		modelId: Model.Id,
	}),
})
export type Input = typeof Input.Type

export const Receipt = Schema.Struct({
	organizationId: Schema.String,
	ownerUserId: Schema.String,
	users: Schema.Array(
		Schema.Struct({ userId: Schema.String, botId: Schema.String }),
	),
	providers: Schema.Array(
		Schema.Struct({ name: Schema.String, providerId: Schema.String }),
	),
})
export type Receipt = typeof Receipt.Type
export const Result = Schema.Struct({
	outcome: Schema.Literals(["created", "unchanged"]),
	...Receipt.fields,
})

export class ProvisionInvalid extends Schema.TaggedError<
	ProvisionInvalid,
	{ readonly brand: unique symbol }
>()("ProvisionInvalid", { message: Schema.String }) {}

const reject = (message: string) =>
	Effect.fail(ProvisionInvalid.make({ message }))
const unique = (values: ReadonlyArray<string>) =>
	Arr.dedupe(values).length === values.length

/** Check the complete manifest before any change. */
export const validate = (input: Input) =>
	Effect.gen(function* () {
		const accounts = Arr.flatMap(input.users, (user) => user.accounts)
		if (
			!unique(Arr.map(input.users, (user) => user.id)) ||
			!unique(Arr.map(input.users, (user) => Str.toLowerCase(user.email))) ||
			!unique(Arr.map(accounts, (account) => account.id)) ||
			Arr.dedupeWith(
				accounts,
				(a, b) => a.providerId === b.providerId && a.subject === b.subject,
			).length !== accounts.length
		)
			return yield* reject(
				"Each user, email and sign-in subject must be unique.",
			)
		if (
			Arr.some(
				accounts,
				(account) =>
					account.providerId !== input.platform.identityProvider.providerId,
			)
		)
			return yield* reject(
				"Every sign-in link must use the configured provider.",
			)
		if (
			!Arr.some(
				input.users,
				(user) => user.id === input.organization.ownerUserId,
			)
		)
			return yield* reject("The owner must be one of the imported users.")
		if (
			!unique(Arr.map(input.models, (model) => model.id)) ||
			!unique(Arr.map(input.providers, (provider) => provider.name))
		)
			return yield* reject("Model IDs and provider names must be unique.")
		if (
			Arr.some(input.providers, (provider) =>
				Arr.some(
					provider.models,
					(link) =>
						link.modelOwner !== "platform" ||
						!Arr.some(input.models, (model) => model.id === link.model),
				),
			)
		)
			return yield* reject(
				"Each provider link must name an imported platform model.",
			)
		const selected = Arr.findFirst(
			input.providers,
			(provider) => provider.name === input.defaultModel.providerName,
		)
		if (
			Option.isNone(selected) ||
			!Arr.some(
				selected.value.models,
				(model) => model.model === input.defaultModel.modelId,
			) ||
			!Arr.some(
				input.models,
				(model) =>
					model.id === input.defaultModel.modelId &&
					(model.type ?? "language") === "language",
			)
		)
			return yield* reject(
				"The default must name a language model offered by a provider.",
			)
	})

/** Canonical JSON is only used in memory to compare inputs and stored rows. */
const canonical = (value: unknown): unknown => {
	if (Arr.isArray(value)) return Arr.map(value, canonical)
	if (Schema.is(Schema.JsonObject)(value)) {
		const entries = Arr.sort(
			Record.toEntries(value),
			Order.mapInput(Order.String, (entry: [string, unknown]) => entry[0]),
		)
		return Record.fromEntries(
			Arr.map(entries, ([key, entry]) => [key, canonical(entry)] as const),
		)
	}
	return value
}

/** A new database, with no executors, is the only valid target. */
const provision = Effect.fn("Provision.run")(function* (input: Input) {
	yield* validate(input)
	const sql = yield* PgClient.PgClient
	const crypto = yield* Crypto.Crypto
	const organization = yield* Organization
	const settings = yield* Settings
	const bots = yield* Bots
	const models = yield* Models
	const providers = yield* ModelProviders
	const admins = yield* PlatformAdmins
	const hash = (value: unknown) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
			canonical(value),
		).pipe(
			Effect.flatMap((text) =>
				crypto
					.digest("SHA-256", new TextEncoder().encode(text))
					.pipe(Effect.orDie),
			),
			Effect.map(Hex.encode),
		)
	const encoded = yield* Schema.encodeEffect(Input)(input)
	const inputDigest = yield* hash(encoded)
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SET LOCAL lock_timeout = '5s'`
			yield* sql`SELECT pg_advisory_xact_lock(hashtext('openbot-provision'))`
			const tables = yield* sql<{
				name: string
			}>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND left(tablename,8)='openbot_' AND tablename <> 'openbot_provisions' AND tablename NOT IN ('openbot_data_upgrades','openbot_data_upgrade_steps','openbot_data_upgrade_failures') ORDER BY tablename`
			for (const table of tables)
				yield* sql`LOCK TABLE ${sql(table.name)} IN ACCESS EXCLUSIVE MODE`
			const snapshot = () =>
				Effect.gen(function* () {
					const rows = yield* Effect.forEach(tables, (table) =>
						sql<{
							row: unknown
						}>`SELECT to_jsonb(t) AS row FROM ${sql(table.name)} t ORDER BY to_jsonb(t)::text`.pipe(
							Effect.map((rows) => ({
								table: table.name,
								rows: Arr.map(rows, (row) => row.row),
							})),
						),
					)
					return {
						count: Arr.reduce(
							rows,
							0,
							(count, table) => count + table.rows.length,
						),
						digest: yield* hash(rows),
					}
				})
			const current = yield* snapshot()
			const receipts = yield* sql<{
				input_digest: string
				data_digest: string
				result: string
			}>`SELECT "inputDigest" AS input_digest,"dataDigest" AS data_digest,result FROM openbot_provisions WHERE id='initial'`
			const saved = receipts[0]
			if (saved !== undefined) {
				if (
					saved.input_digest !== inputDigest ||
					saved.data_digest !== current.digest
				)
					return yield* reject(
						"The input or target changed after setup. No data was changed.",
					)
				return {
					outcome: "unchanged" as const,
					...(yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(
						saved.result,
					)),
				}
			}
			if (current.count !== 0)
				return yield* reject("The target must be empty. No data was changed.")
			yield* AuthImport.insert(input.users)
			const owner = Option.getOrThrow(
				Arr.findFirst(
					input.users,
					(user) => user.id === input.organization.ownerUserId,
				),
			)
			const org = yield* organization.create({
				name: input.organization.name,
				owner,
			})
			yield* Setup.run({
				publicOrigin: input.platform.publicOrigin,
				browserAuth: input.platform.browserAuth,
				identityProvider: Option.some({
					...input.platform.identityProvider,
					clientSecret: Option.fromNullishOr(
						input.platform.identityProvider.clientSecret,
					),
				}),
				adminEmails: [owner.email],
				force: false,
				authSecret: Option.some(input.platform.authSecret),
				fileStorage: Option.some(input.platform.fileStorage),
				memberSignupOrganizationId: input.organization.allowNewAccounts
					? org.id
					: null,
			})
			yield* admins.check(owner)
			for (const user of input.users) {
				if (user.id === owner.id) continue
				const invite = yield* organization.createInvitation({
					organizationId: org.id,
					email: user.email,
					roles: ["member"],
					invitedBy: owner.id,
				})
				yield* organization.answerInvitation(user.id, invite.id, "accepted")
			}
			const availability = {
				_tag: "Selected" as const,
				organizations: [org.id],
			}
			for (const model of input.models)
				yield* models.create(platformOwner, { ...model, availability })
			const createdProviders = yield* Effect.forEach(
				input.providers,
				(provider) =>
					providers.create(platformOwner, { ...provider, availability }),
			)
			const selected = Option.getOrThrow(
				Arr.findFirst(
					createdProviders,
					(provider) => provider.name === input.defaultModel.providerName,
				),
			)
			const model = Config.Selection.make({
				provider: Provider.Id.make(selected.id),
				model: input.defaultModel.modelId,
			})
			const orgSettings = yield* settings.organization(org.id)
			yield* settings.updateOrganization(
				org.id,
				orgSettings.version,
				(current) =>
					Effect.succeed({
						...current,
						chatModel: model,
						rulesModel: model,
						botMemoryModel: model,
					}),
			)
			const users = yield* Effect.forEach(input.users, (user) =>
				Effect.gen(function* () {
					const bot = yield* bots.create(
						{ kind: "member", organizationId: org.id, userId: user.id },
						{ ...input.bot, model },
					)
					const current = yield* settings.member(org.id, user.id)
					yield* settings.updateMember(
						org.id,
						user.id,
						current.version,
						(document) => Effect.succeed({ ...document, defaultBot: bot.id }),
					)
					return { userId: user.id, botId: bot.id }
				}),
			)
			const result: Receipt = {
				organizationId: org.id,
				ownerUserId: owner.id,
				users,
				providers: Arr.map(createdProviders, (provider) => ({
					name: provider.name,
					providerId: provider.id,
				})),
			}
			const data = yield* snapshot()
			const resultText = yield* Schema.encodeEffect(
				Schema.fromJsonString(Receipt),
			)(result)
			yield* sql`INSERT INTO openbot_provisions(id,"inputDigest","dataDigest",result) VALUES('initial',${inputDigest},${data.digest},${resultText})`
			return { outcome: "created" as const, ...result }
		}),
	)
})

/** The command keeps the cause for private diagnostics and never prints its values. */
export class ProvisionFailed extends Schema.TaggedError<
	ProvisionFailed,
	{ readonly brand: unique symbol }
>()("ProvisionFailed", { cause: Schema.Defect() }) {}
export const run = (input: Input) =>
	provision(input).pipe(
		Effect.mapError((cause) => ProvisionFailed.make({ cause })),
	)

/** Only storage and account services; no Chat, task, model or tool execution starts. */
export const layer = Layer.mergeAll(
	botsLayer,
	ModelsPostgres.layer,
	ModelProvidersPostgres.layer,
).pipe(
	Layer.provideMerge(BotRecords.layer),
	Layer.provideMerge(
		AuthorizationLayer.layer.pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					TokensPostgres.layer,
					RolesPostgres.layer,
					OrganizationPostgres.layer,
					PlatformAdminsPostgres.layer,
				),
			),
		),
	),
	Layer.provideMerge(AuditLogPostgres.layer),
)
