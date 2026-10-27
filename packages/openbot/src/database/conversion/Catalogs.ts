import { Execution } from "@openbot-build/domain"
import { Array as Arr, Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as DeveloperWatches from "../../apps/DeveloperWatches.ts"
import * as IndexWork from "../../apps/IndexWork.ts"
import { Store } from "../../execution/Store.ts"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Imported from "./Executions.ts"
import * as Legacy from "./LegacyCatalogs.ts"
import * as Version from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

export class InvalidCatalogRecord extends Schema.TaggedError<
	InvalidCatalogRecord,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidCatalogRecord", { message: Schema.String }) {}
const invalid = (message: string) => InvalidCatalogRecord.make({ message })
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema), {
		onExcessProperty: "error",
	})
const tables = [
	["app_records", ["owner", "card_url"]],
	["app_drafts", ["owner", "id"]],
	["app_connections", ["owner", "id"]],
	["app_index_entries", ["namespace", "card_url"]],
	["app_index_results", ["namespace", "card_url", "generation"]],
	["app_index_jobs", ["namespace", "card_url"]],
	["developer_claims", ["namespace", "id"]],
	["developer_proofs", ["namespace", "id"]],
	["developer_members", ["namespace", "id"]],
	["developer_invitations", ["namespace", "id"]],
	["developer_apps", ["namespace", "card_url"]],
	["developer_reports", ["namespace", "id"]],
	["developer_index_requests", ["namespace", "id"]],
	["developer_subscriptions", ["namespace", "owner", "card_url"]],
	["developer_notices", ["namespace", "id"]],
] as const
export type Kind = (typeof tables)[number][0]
type Row = { key: string; body: string }
const keyOfScope = (scope: typeof Legacy.ManagementScope.Type) =>
	scope._tag === "AppCard"
		? `card:${scope.cardUrl}`
		: `hostname:${scope.hostname}`

/** Maintenance enrolls reads and timers. The engine starts them only after the data checks pass. */
export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const progress = yield* Progress.make
	const imported = yield* Imported.make
	const digest = (value: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(value))
			.pipe(Effect.map(Hex.encode))
	const ownerOf = (value: string) =>
		Schema.decodeEffect(Version.Owner)(value).pipe(
			Effect.map(([organizationId, userId]) => ({ organizationId, userId })),
		)
	const open = <S extends Schema.ConstraintDecoder<unknown>>(
		schema: S,
		body: string,
		binding: ReadonlyArray<string>,
	) =>
		encode(binding).pipe(
			Effect.flatMap((aad) => secrets.open(body, aad)),
			Effect.flatMap(decode(schema)),
		)
	const watch = (
		namespace: string,
		ref: DeveloperWatches.Reference,
		due: number,
	) =>
		Effect.gen(function* () {
			yield* sql`insert into openbot_developer_watches ${sql.insert({ namespace, kind: ref.kind, resource_id: ref.id, next_check_at: due })} on conflict (namespace, kind, resource_id) do nothing`
			const [current] = yield* sql<{
				execution_id: string | null
			}>`select execution_id from openbot_developer_watches where namespace = ${namespace} and kind = ${ref.kind} and resource_id = ${ref.id} for update`
			if (current?.execution_id != null) return
			const resourceId = yield* digest(`${ref.kind}:${ref.id}`)
			const receipt = yield* store.submit(
				`developer-monitor:${namespace}`,
				Execution.CommandKey.make(`import-watch:${resourceId}`),
				{
					workflow: DeveloperWatches.workflowName,
					identity: DeveloperWatches.identity,
					resource: { kind: "DeveloperWatch", id: resourceId },
					input: { namespace, ref },
				},
			)
			yield* sql`update openbot_developer_watches set execution_id = ${receipt.executionId} where namespace = ${namespace} and kind = ${ref.kind} and resource_id = ${ref.id}`
		})
	const validate = (kind: Kind, raw: Schema.Json) =>
		Effect.gen(function* () {
			// Row codecs omit new execution links. Saved business fields have fixed codecs.
			const value = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					owner: Schema.optionalKey(Schema.NullOr(Schema.String)),
				}),
			)(raw)
			if (value.owner != null) yield* ownerOf(value.owner)
			switch (kind) {
				case "app_records": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.AppRow)(raw)
					const body = yield* decode(Legacy.AppRecord)(row.body)
					if (body.cardUrl !== row.card_url)
						return yield* invalid("The App record has another Card URL.")
					return { ...row, body }
				}
				case "app_drafts": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.DraftRow)(raw)
					const body = yield* decode(Legacy.Draft)(row.body)
					if (body.id !== row.id)
						return yield* invalid("The connection draft has another ID.")
					return { ...row, body }
				}
				case "app_connections": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.ConnectionRow)(
						raw,
					)
					const body = yield* open(Legacy.StoredConnection, row.body, [
						"connection",
						row.owner,
						row.id,
					])
					if (
						body.connection.owner !== row.owner ||
						body.connection.connectionId !== row.id ||
						body.name !== row.name ||
						body.revision !== row.revision
					)
						return yield* invalid(
							"The connection indexes do not match its sealed body.",
						)
					if (row.verification !== null)
						yield* decode(Legacy.Availability)(row.verification)
					const [app] =
						yield* sql`select card_url from openbot_app_records where owner = ${row.owner} and card_url = ${body.connection.cardUrl}`
					if (app === undefined)
						return yield* invalid("The connection has no saved App record.")
					const authorization = body.connection.authorization
					if (
						authorization._tag === "Authorized" &&
						(authorization.binding.owner !== row.owner ||
							authorization.binding.connectionId !== row.id)
					)
						return yield* invalid(
							"The connection grant has another owner or connection.",
						)
					return { ...row, body }
				}
				case "app_index_entries": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.EntryRow)(raw)
					const body = yield* decode(Legacy.Entry)(row.body)
					if (
						body.cardUrl !== row.card_url ||
						Arr.some(
							body.evidence,
							(evidence) => evidence.cardUrl !== row.card_url,
						)
					)
						return yield* invalid(
							"The public Index entry has another Card URL.",
						)
					return { ...row, body }
				}
				case "app_index_results":
					return yield* Schema.decodeUnknownEffect(Legacy.IndexResult)(raw)
				case "app_index_jobs":
					return yield* Schema.decodeUnknownEffect(Legacy.IndexJob)(raw)
				case "developer_claims": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.Claim)(raw)
					if (row.scope_key !== keyOfScope(row.scope))
						return yield* invalid(
							"The claim scope key does not match its scope.",
						)
					return row
				}
				case "developer_proofs": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.Proof)(raw)
					const [claim] = yield* sql<{
						owner: string
						scope_key: string
						token: string
					}>`select owner, scope_key, token from openbot_developer_claims where namespace = ${row.namespace} and id = ${row.id}`
					if (
						row.scope_key !== keyOfScope(row.scope) ||
						claim?.owner !== row.owner ||
						claim.scope_key !== row.scope_key ||
						claim.token !== row.token
					)
						return yield* invalid("The proof does not match its claim.")
					return row
				}
				case "developer_members":
					return yield* Schema.decodeUnknownEffect(Legacy.Member)(raw)
				case "developer_invitations": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.Invitation)(raw)
					const [proof] = yield* sql<{
						owner: string
					}>`select owner from openbot_developer_proofs where namespace = ${row.namespace} and id = ${row.proof_id}`
					if (proof?.owner !== row.owner)
						return yield* invalid("The invitation has another proof owner.")
					if (row.accepted_by !== null) yield* ownerOf(row.accepted_by)
					if ((row.status === "Accepted") !== (row.accepted_by !== null))
						return yield* invalid(
							"The invitation result has no matching account.",
						)
					return row
				}
				case "developer_apps": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.DeveloperApp)(
						raw,
					)
					if (row.candidate.cardUrl !== row.card_url)
						return yield* invalid("The developer App has another Card URL.")
					return row
				}
				case "developer_reports": {
					const row = yield* Schema.decodeUnknownEffect(Legacy.DeveloperReport)(
						raw,
					)
					if (row.report.checkedAt !== row.checked_at)
						return yield* invalid("The report time does not match its index.")
					return row
				}
				case "developer_index_requests":
					return yield* Schema.decodeUnknownEffect(Legacy.IndexRequest)(raw)
				case "developer_subscriptions":
					return yield* Schema.decodeUnknownEffect(Legacy.Subscription)(raw)
				case "developer_notices":
					return yield* Schema.decodeUnknownEffect(Legacy.Notice)(raw)
			}
		})
	const knownCheck = (request: typeof Legacy.IndexRequest.Type) =>
		Effect.gen(function* () {
			const [result] = yield* sql<{
				check: string
			}>`select "check" from openbot_app_index_results where namespace = ${request.namespace} and card_url = ${request.card_url} and generation = ${request.generation}`
			if (result !== undefined) return yield* decode(Legacy.Check)(result.check)
			const [job] = yield* sql<{
				check: string | null
			}>`select "check" from openbot_app_index_jobs where namespace = ${request.namespace} and card_url = ${request.card_url} and completed_generation = ${request.generation}`
			return job?.check == null ? null : yield* decode(Legacy.Check)(job.check)
		})
	const enroll = (kind: Kind, raw: Schema.Json, sourceKey: string) =>
		Effect.gen(function* () {
			if (kind === "app_index_jobs") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.IndexJob)(raw)
				const [current] = yield* sql<{
					execution_id: string | null
				}>`select execution_id from openbot_app_index_jobs where namespace = ${row.namespace} and card_url = ${row.card_url}`
				if (current?.execution_id != null) return
				const resourceId = yield* digest(row.card_url)
				const receipt = yield* store.submit(
					`index:${row.namespace}`,
					Execution.CommandKey.make(`import-watch:${resourceId}`),
					{
						workflow: IndexWork.workflowName,
						identity: IndexWork.identity,
						resource: { kind: "IndexWatch", id: resourceId },
						input: { indexNamespace: row.namespace, cardUrl: row.card_url },
					},
				)
				yield* sql`update openbot_app_index_jobs set execution_id = ${receipt.executionId} where namespace = ${row.namespace} and card_url = ${row.card_url}`
			} else if (kind === "developer_apps") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.DeveloperApp)(raw)
				yield* watch(
					row.namespace,
					{ kind: "App", id: row.card_url },
					row.next_check_at,
				)
			} else if (kind === "developer_proofs") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.Proof)(raw)
				if (row.status !== "Relinquished")
					yield* watch(
						row.namespace,
						{ kind: "Proof", id: row.id },
						row.next_verification_at,
					)
			} else if (kind === "developer_index_requests") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.IndexRequest)(raw)
				const [current] = yield* sql<{
					execution_id: string | null
				}>`select execution_id from openbot_developer_index_requests where namespace = ${row.namespace} and id = ${row.id}`
				if (current?.execution_id != null) return
				const owner = yield* ownerOf(row.owner)
				const check = yield* knownCheck(row)
				const completed = check !== null && check._tag !== "Pending"
				const key = yield* imported.write({
					namespace: row.owner,
					collection: "index-request",
					sourceKey,
					resource: { kind: "IndexRequest", id: row.id },
					input: {
						_tag: "Imported",
						format: 1,
						source: Version.source,
						owner,
						authority: Authority.missing(owner),
						reason: completed ? "History" : "OriginalCallerMissing",
						history: { _tag: "IndexRequest", version: 1, request: row, check },
					},
					status: completed ? "completed" : "interrupted",
					createdAt: row.accepted_at,
					updatedAt:
						check !== null && check._tag !== "Pending"
							? check.attemptedAt
							: row.accepted_at,
				})
				yield* sql`update openbot_developer_index_requests set execution_id = ${key.id} where namespace = ${row.namespace} and id = ${row.id}`
			}
		})
	const enrollment = (kind: Kind, raw: Schema.Json) =>
		Effect.gen(function* () {
			if (kind === "app_index_jobs") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.IndexJob)(raw)
				const [link] = yield* sql<{
					execution_id: string | null
				}>`select execution_id from openbot_app_index_jobs where namespace = ${row.namespace} and card_url = ${row.card_url}`
				if (link?.execution_id == null)
					return yield* invalid("The public Index job has no execution.")
				const saved = yield* store.loadService(
					{
						namespace: `index:${row.namespace}`,
						id: Execution.Id.make(link.execution_id),
					},
					IndexWork.serviceId,
				)
				if (
					saved.workflow !== IndexWork.workflowName ||
					saved.identity.owner.kind !== "platform" ||
					saved.record.resource.kind !== "IndexWatch" ||
					saved.record.resource.id !== (yield* digest(row.card_url)) ||
					!Schema.toEquivalence(Schema.Json)(saved.input, {
						indexNamespace: row.namespace,
						cardUrl: row.card_url,
					})
				)
					return yield* invalid("The public Index job has another execution.")
			} else if (kind === "developer_apps" || kind === "developer_proofs") {
				const row = yield* kind === "developer_apps"
					? Schema.decodeUnknownEffect(Legacy.DeveloperApp)(raw)
					: Schema.decodeUnknownEffect(Legacy.Proof)(raw)
				if ("status" in row && row.status === "Relinquished") return
				const ref =
					"candidate" in row
						? { kind: "App" as const, id: row.card_url }
						: { kind: "Proof" as const, id: row.id }
				const due =
					"candidate" in row ? row.next_check_at : row.next_verification_at
				const [link] = yield* sql<{
					execution_id: string | null
					next_check_at: number
				}>`select execution_id, next_check_at::float8 from openbot_developer_watches where namespace = ${row.namespace} and kind = ${ref.kind} and resource_id = ${ref.id}`
				if (link?.execution_id == null)
					return yield* invalid("The developer monitor has no execution.")
				const saved = yield* store.loadService(
					{
						namespace: `developer-monitor:${row.namespace}`,
						id: Execution.Id.make(link.execution_id),
					},
					DeveloperWatches.serviceId,
				)
				if (
					saved.workflow !== DeveloperWatches.workflowName ||
					saved.identity.owner.kind !== "platform" ||
					saved.record.resource.kind !== "DeveloperWatch" ||
					saved.record.resource.id !==
						(yield* digest(`${ref.kind}:${ref.id}`)) ||
					!Schema.toEquivalence(Schema.Json)(saved.input, {
						namespace: row.namespace,
						ref,
					}) ||
					link.next_check_at !== due
				)
					return yield* invalid(
						"The developer monitor changed its saved check.",
					)
			} else if (kind === "developer_index_requests") {
				const row = yield* Schema.decodeUnknownEffect(Legacy.IndexRequest)(raw)
				const [link] = yield* sql<{
					execution_id: string | null
				}>`select execution_id from openbot_developer_index_requests where namespace = ${row.namespace} and id = ${row.id}`
				if (link?.execution_id == null)
					return yield* invalid("The old Index request has no execution.")
				const saved = yield* store.loadService(
					{ namespace: row.owner, id: Execution.Id.make(link.execution_id) },
					Imported.serviceId,
				)
				const input = yield* Schema.decodeUnknownEffect(Imported.Input)(
					saved.input,
				)
				const history = yield* Schema.decodeUnknownEffect(
					Legacy.IndexRequestHistory,
				)(input.history)
				const owner = yield* ownerOf(row.owner)
				const check = yield* knownCheck(row)
				if (
					saved.workflow !== Imported.workflowName ||
					saved.record.resource.kind !== "IndexRequest" ||
					saved.record.resource.id !== row.id ||
					!Schema.toEquivalence(Authority.Owner)(input.owner, owner) ||
					!Schema.toEquivalence(Schema.Json)(history.request, row) ||
					!Schema.toEquivalence(Schema.NullOr(Legacy.Check))(
						history.check,
						check,
					)
				)
					return yield* invalid(
						"The old Index request does not match its history.",
					)
			}
		})
	const steps = Arr.map(tables, ([kind, keys]) => {
		const key = sql`json_build_array(${sql.join(", ")(Arr.map(keys, (key) => sql`${sql(key)}`))})::text`
		const table = sql(`openbot_${kind}`)
		const read = (cursor: string | null, limit: number) =>
			sql<Row>`select ${key} as key, to_jsonb(t)::text as body from ${table} t where (${cursor}::text is null or ${key} > ${cursor}) order by ${key} limit ${limit}`
		const collection = `catalog:${kind}`
		return {
			name: `catalogs:${kind}`,
			kind,
			collection,
			read,
			key: (row: Row) => row.key,
			convert: (row: Row) =>
				Effect.gen(function* () {
					const raw = yield* Schema.decodeEffect(json)(row.body)
					const value = yield* validate(kind, raw)
					yield* enroll(kind, raw, row.key)
					yield* progress.record(collection, row.key, "converted", value)
				}),
			check: (row: Row) =>
				Effect.gen(function* () {
					const raw = yield* Schema.decodeEffect(json)(row.body)
					const value = yield* validate(kind, raw)
					const [proof] = yield* sql<{
						body: string
					}>`select body from openbot_data_upgrade_records where version = ${Progress.version} and collection = ${collection} and key = ${row.key}`
					if (proof === undefined)
						return yield* invalid("A catalog row has no data move record.")
					const previous = yield* open(Schema.Json, proof.body, [
						"data-upgrade",
						Progress.version,
						collection,
						row.key,
					])
					if (!Schema.toEquivalence(Schema.Json)(value, previous))
						return yield* invalid("A catalog row changed during the data move.")
					yield* enrollment(kind, raw)
				}),
		}
	})
	const run = (limit = 100) =>
		Effect.gen(function* () {
			for (const step of steps) {
				let complete = false
				while (!complete)
					complete = (yield* progress.batch(step, limit)).complete
			}
		})
	const verify = Effect.forEach(
		steps,
		(step) => progress.verify({ ...step, name: `verify:${step.name}` }),
		{ discard: true },
	)
	const check = Effect.gen(function* () {
		for (const step of steps) {
			const [row] = yield* sql<{
				count: number
			}>`select count(*)::float8 as count from ${sql(`openbot_${step.kind}`)}`
			const [proof] = yield* sql<{
				count: number
			}>`select count(*)::float8 as count from openbot_data_upgrade_records where version = ${Progress.version} and collection = ${step.collection}`
			const [progressRow] = yield* sql<{
				rows: number
				complete: boolean
			}>`select rows::float8 as rows, complete from openbot_data_upgrade_steps where version = ${Progress.version} and step = ${step.name}`
			if (
				row === undefined ||
				proof?.count !== row.count ||
				progressRow?.rows !== row.count ||
				!progressRow.complete
			)
				return yield* invalid("The catalog data move counts do not match.")
		}
	})
	return { run, verify, check }
})
export const run = make.pipe(Effect.flatMap((move) => move.run()))
export const verify = make.pipe(Effect.flatMap((move) => move.verify))
export const check = make.pipe(Effect.flatMap((move) => move.check))
