import {
	Authorization,
	Models,
	Organizations,
	Roles,
} from "@openbot-build/domain"
import { Array as Arr, Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as Documents from "../../settings/Documents.ts"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Imported from "./Executions.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

const json = Schema.fromJsonString(Schema.Json)
const texts = Schema.Array(Schema.String)
const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema))
const fail = (message: string) => Progress.InvalidData.make({ message })
const FileRow = Schema.Struct({
	id: Schema.NonEmptyString,
	organization_id: Schema.NonEmptyString,
	user_id: Schema.NonEmptyString,
	filename: Schema.String,
	media_type: Schema.NonEmptyString,
	bytes: Schema.Natural,
	status: Schema.Literals(["pending", "ready", "deleting"]),
	object_key: Schema.NonEmptyString,
	cleanup_execution_id: Schema.NullOr(Schema.String),
	created_at: Schema.Natural,
	updated_at: Schema.Natural,
})

/** The maintenance program records old unfinished work. It never calls object storage. */
export const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const progress = yield* Progress.make
	const imported = yield* Imported.make
	let complete = false
	while (!complete) {
		const result = yield* progress.batch(
			{
				name: "resources:file-deletions",
				read: (cursor, limit) =>
					sql<{
						key: string
						body: string
					}>`select id as key, to_jsonb(f)::text as body from openbot_files f where status = 'deleting' and cleanup_execution_id is null and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
				key: (row) => row.key,
				convert: (row) =>
					Effect.gen(function* () {
						const file = yield* decode(FileRow)(row.body)
						const owner = {
							organizationId: file.organization_id,
							userId: file.user_id,
						}
						const saved = yield* imported.write({
							namespace: yield* Schema.encodeEffect(json)([
								owner.organizationId,
								owner.userId,
							]),
							collection: "file-deletion",
							sourceKey: file.id,
							resource: { kind: "File", id: file.id },
							input: {
								_tag: "Imported",
								format: 1,
								source: Legacy.source,
								owner,
								authority: Authority.missing(owner),
								reason: "CheckpointMissing",
								history: file,
							},
							status: "interrupted",
							createdAt: file.created_at,
							updatedAt: file.updated_at,
						})
						yield* sql`update openbot_files set cleanup_execution_id = ${saved.id} where id = ${file.id}`
					}),
			},
			100,
		)
		complete = result.complete
	}
	complete = false
	while (!complete) {
		const result = yield* progress.batch(
			{
				name: "resources:usage-holds",
				read: (cursor, limit) =>
					sql<{
						key: string
						cost_micros: bigint
						charged: boolean
					}>`select id as key, cost_micros, charged from openbot_usage_events where status = 'pending' and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
				key: (row) => row.key,
				convert: (row) =>
					Effect.gen(function* () {
						if (row.charged || row.cost_micros !== 0n)
							return yield* fail("A pending model call already has a charge.")
						yield* sql`update openbot_usage_events set status = 'unknown', estimated_micros = coalesce(estimated_micros, reserved_micros), reserved_micros = 0 where id = ${row.key}`
						yield* progress.record("usage-hold", row.key, "converted", {
							status: "unknown",
							reason: "OldCallEnded",
						})
					}),
			},
			100,
		)
		complete = result.complete
	}
})

/** Resources that do not run work still need all their secrets and references checked. */
export const verify = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const progress = yield* Progress.make
	const table = <S extends Schema.Decoder<unknown>, E>(
		name: string,
		keys: ReadonlyArray<string>,
		schema: S,
		inspect: (row: S["Type"]) => Effect.Effect<void, E>,
	) => {
		const key = sql`jsonb_build_array(${sql.join(", ")(Arr.map(keys, (key) => sql`${sql(key)}`))})::text`
		return progress.verify({
			name: `verify:${name}`,
			read: (cursor, limit) =>
				sql<{
					key: string
					body: string
				}>`select ${key} as key, to_jsonb(t)::text as body from ${sql(name)} t where (${cursor}::text is null or ${key} > ${cursor}) order by ${key} limit ${limit}`,
			key: (row) => row.key,
			check: (row) => decode(schema)(row.body).pipe(Effect.flatMap(inspect)),
		})
	}
	const open = (body: string, binding: string) =>
		secrets.open(body, binding).pipe(Effect.asVoid)
	const policy = Schema.decodeEffect(Authorization.PolicySchema)
	yield* table(
		"openbot_settings",
		["scope_kind", "scope_id"],
		Schema.Struct({
			scope_kind: Schema.Literals(["platform", "organization", "member"]),
			scope_id: Schema.NonEmptyString,
			document: Schema.String,
			version: Schema.Natural,
		}),
		(row) =>
			Effect.gen(function* () {
				if (row.scope_kind === "platform") {
					if (row.scope_id !== "platform")
						return yield* fail("The platform settings have another owner.")
					const value = yield* decode(Legacy.PlatformSecrets)(row.document)
					yield* open(value.authSecret, "openbot_settings:platform:authSecret")
					if (value.identityProvider?.clientSecret != null)
						yield* open(
							value.identityProvider.clientSecret,
							"openbot_settings:platform:identityProvider.clientSecret",
						)
					if (value.files?.storage != null)
						yield* open(
							value.files.storage.secretAccessKey,
							"openbot_settings:platform:files.storage.secretAccessKey",
						)
					yield* decode(Documents.PlatformDocument)(row.document)
				} else if (row.scope_kind === "organization")
					yield* decode(Documents.OrganizationDocument)(row.document)
				else yield* decode(Documents.MemberDocument)(row.document)
			}),
	)
	yield* table(
		"openbot_organizations",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			name: Schema.String,
			status: Organizations.OrganizationStatus,
		}),
		() => Effect.void,
	)
	yield* table(
		"openbot_members",
		["organization_id", "user_id"],
		Schema.Struct({
			status: Organizations.MemberStatus,
			roles: Schema.String,
			policy: Schema.String,
		}),
		(row) =>
			Effect.gen(function* () {
				yield* decode(Organizations.Roles)(row.roles)
				yield* policy(row.policy)
			}),
	)
	yield* table(
		"openbot_roles",
		["organization_id", "id"],
		Schema.Struct({ id: Roles.RoleId, policy: Schema.String }),
		(row) => policy(row.policy).pipe(Effect.asVoid),
	)
	yield* table(
		"openbot_tokens",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			hash: Schema.NonEmptyString,
			policy: Schema.String,
		}),
		(row) => policy(row.policy).pipe(Effect.asVoid),
	)
	yield* table(
		"openbot_auth_user",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			email: Schema.NonEmptyString,
			name: Schema.String,
			email_verified: Schema.Boolean,
		}),
		() => Effect.void,
	)
	yield* table(
		"openbot_auth_account",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			user_id: Schema.NonEmptyString,
			provider_id: Schema.NonEmptyString,
			account_id: Schema.NonEmptyString,
		}),
		() => Effect.void,
	)
	yield* table(
		"openbot_auth_session",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			user_id: Schema.NonEmptyString,
			token: Schema.NonEmptyString,
			expires_at: Schema.NonEmptyString,
		}),
		() => Effect.void,
	)
	yield* table(
		"openbot_auth_verification",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			identifier: Schema.NonEmptyString,
			value: Schema.String,
			expires_at: Schema.NonEmptyString,
		}),
		() => Effect.void,
	)
	yield* table(
		"openbot_invitations",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			roles: Schema.String,
			secret_hash: Schema.NullOr(Schema.String),
			secret: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				yield* decode(texts)(row.roles)
				if (row.secret !== null) {
					if (row.secret_hash === null)
						return yield* fail("An invitation secret has no saved hash.")
					const value = yield* secrets.open(
						row.secret,
						`bot_invitation:${row.secret_hash}`,
					)
					const hash = Hex.encode(
						yield* crypto.digest("SHA-256", new TextEncoder().encode(value)),
					)
					if (hash !== row.secret_hash)
						return yield* fail("An invitation secret does not match its hash.")
				}
			}),
	)
	yield* table(
		"openbot_sso_connections",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			domains: Schema.String,
			client_secret: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				yield* decode(texts)(row.domains)
				if (row.client_secret !== null)
					yield* open(
						row.client_secret,
						`openbot_sso_connections:${row.id}:client_secret`,
					)
			}),
	)
	yield* table(
		"openbot_model_providers",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			owner_kind: Models.ProviderOwner,
			kind: Models.ProviderKind,
			api_key: Schema.String,
			availability: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				yield* open(row.api_key, `openbot_model_providers:${row.id}:api_key`)
				if (row.availability !== null)
					yield* decode(Models.Availability)(row.availability)
			}),
	)
	yield* table(
		"openbot_models",
		["owner_kind", "owner_id", "id"],
		Schema.Struct({
			owner_kind: Models.ProviderOwner,
			type: Models.ModelType,
			reasoning_efforts: Schema.String,
			service_tiers: Schema.String,
			availability: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				yield* decode(texts)(row.reasoning_efforts)
				yield* decode(texts)(row.service_tiers)
				if (row.availability !== null)
					yield* decode(Models.Availability)(row.availability)
			}),
	)
	yield* table(
		"openbot_provider_models",
		["provider_id", "model_id"],
		Schema.Struct({
			reasoning_efforts: Schema.NullOr(Schema.String),
			service_tiers: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				if (row.reasoning_efforts !== null)
					yield* decode(texts)(row.reasoning_efforts)
				if (row.service_tiers !== null) yield* decode(texts)(row.service_tiers)
			}),
	)
	yield* table(
		"openbot_secret_providers",
		["organization_id", "id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			kind: Schema.NonEmptyString,
			credentials: Schema.String,
			hints: Schema.String,
		}),
		(row) =>
			Effect.gen(function* () {
				const value = yield* secrets
					.open(
						row.credentials,
						`openbot_secret_providers:${row.id}:credentials`,
					)
					.pipe(Effect.flatMap(decode(Legacy.SecretCredentials)))
				if (value.kind !== row.kind)
					return yield* fail(
						"A secret provider kind does not match its credentials.",
					)
				yield* decode(Schema.Json)(row.hints)
			}),
	)
	yield* table(
		"openbot_computer_providers",
		["organization_id", "id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			kind: Schema.NonEmptyString,
			credentials: Schema.String,
			hints: Schema.String,
		}),
		(row) =>
			Effect.gen(function* () {
				const value = yield* secrets
					.open(
						row.credentials,
						`openbot_computer_providers:${row.id}:credentials`,
					)
					.pipe(Effect.flatMap(decode(Legacy.ComputerCredentials)))
				if (value.kind !== row.kind)
					return yield* fail(
						"A Computer provider kind does not match its credentials.",
					)
				yield* decode(Schema.Json)(row.hints)
			}),
	)
	yield* table(
		"openbot_computer_pairings",
		["id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			token: Schema.NullOr(Schema.String),
		}),
		(row) =>
			row.token === null
				? Effect.void
				: open(row.token, `openbot_computer_pairings:${row.id}:token`),
	)
	yield* table(
		"openbot_vault_items",
		["organization_id", "id"],
		Schema.Struct({
			id: Schema.NonEmptyString,
			provider_id: Schema.NullOr(Schema.String),
			source: Schema.String,
			fields: Schema.String,
			exits: Schema.String,
			values: Schema.NullOr(Schema.String),
		}),
		(row) =>
			Effect.gen(function* () {
				const source = yield* decode(Legacy.VaultSource)(row.source)
				const fields = yield* decode(texts)(row.fields)
				yield* decode(Legacy.VaultExits)(row.exits)
				if (source._tag === "Builtin") {
					if (row.provider_id !== null || row.values === null)
						return yield* fail(
							"A built-in Vault item has no values or has a provider.",
						)
					const values = yield* secrets
						.open(row.values, `openbot_vault_items:${row.id}:values`)
						.pipe(Effect.flatMap(decode(Legacy.VaultValues)))
					if (!Arr.every(fields, (field) => values[field] !== undefined))
						return yield* fail("A Vault item field has no saved value.")
				} else if (source.provider !== row.provider_id || row.values !== null)
					return yield* fail(
						"A Vault item source does not match its saved provider.",
					)
			}),
	)
	yield* table("openbot_files", ["id"], FileRow, (row) =>
		Effect.gen(function* () {
			if (row.status === "deleting" && row.cleanup_execution_id === null)
				return yield* fail("A file deletion has no execution record.")
		}),
	)
	const reference = <E>(
		name: string,
		count: Effect.Effect<ReadonlyArray<{ count: number }>, E>,
	) =>
		progress.check(
			`reference:${name}`,
			Effect.gen(function* () {
				if ((yield* count)[0]?.count !== 0)
					return yield* fail(`The ${name} references are not valid.`)
			}),
		)
	for (const name of [
		"openbot_secret_providers",
		"openbot_vaults",
		"openbot_computer_providers",
		"openbot_computers",
	] as const) {
		yield* reference(
			name,
			sql`select count(*)::float8 as count from ${sql(name)} r left join openbot_organizations o on o.id = r.organization_id where o.id is null`,
		)
	}
	yield* reference(
		"settings",
		sql`select count(*)::float8 as count from openbot_settings s where (scope_kind = 'organization' and not exists (select 1 from openbot_organizations o where o.id = s.scope_id)) or (scope_kind = 'member' and not exists (select 1 from openbot_members m where m.organization_id || '/' || m.user_id = s.scope_id))`,
	)
	for (const name of ["openbot_models", "openbot_model_providers"] as const) {
		yield* reference(
			name,
			sql`select count(*)::float8 as count from ${sql(name)} r where (owner_kind = 'organization' and not exists (select 1 from openbot_organizations o where o.id = r.owner_id)) or (owner_kind = 'platform' and owner_id <> 'platform')`,
		)
	}
	yield* reference(
		"file-cleanup",
		sql`select count(*)::float8 as count from openbot_files f left join openbot_executions e on e.id = f.cleanup_execution_id where f.cleanup_execution_id is not null and (e.id is null or e.resource_kind <> 'File' or e.resource_id <> f.id)`,
	)
	// A Chat may name a deleted file. Existing files must still belong to the Chat owner.
	yield* reference(
		"file-owner",
		sql`select count(*)::float8 as count from openbot_file_refs r join openbot_files f on f.id = r.file join openbot_chats c on c.namespace = r.namespace and c.id = r.chat where c.namespace::jsonb <> jsonb_build_array(f.organization_id, f.user_id)`,
	)
	yield* reference(
		"usage-holds",
		sql`select count(*)::float8 as count from openbot_usage_events where status not in ('confirmed', 'unknown') or reserved_micros <> 0 or (status = 'unknown' and (charged or cost_micros <> 0))`,
	)
})
