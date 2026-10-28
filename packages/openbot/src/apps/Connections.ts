import {
	Authorization,
	AppConnections as Api,
	AppIndex,
	AppDiscovery,
	ConnectionId,
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/domain"
import type * as Models from "./ConnectionModels.ts"
import { AppConnections, Discovery, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashMap,
	Layer,
	Match,
	Option,
	Redacted,
	Schema,
} from "effect"
import type { PgClient } from "@effect/sql-pg"
import { sql } from "drizzle-orm"
import * as Check from "../authorization/Check.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as DiscoveryService from "./Discovery.ts"
import * as ManualConnection from "./ManualConnection.ts"
import { Governance } from "./Governance.ts"
import { Probe } from "./Probe.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { appConnections, appDrafts } from "../database/Schema.ts"
import { IndexWork } from "./IndexWork.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey, type StoredConnection } from "./StoredConnections.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"

export type Error =
	| ExperienceInputInvalid
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| AppDiscovery.Failed
	| Api.ConnectionConflict
	| Api.ConnectionConfigurationInvalid
	| AppIndex.AppRestricted
/** Every private operation still explicitly needs the request identity. @effect-expect-leaking Identity */
export class Connections extends Context.Service<
	Connections,
	{
		readonly listConnections: Effect.Effect<
			ReadonlyArray<Models.Connection>,
			Error | Authorization.PolicyUnavailable,
			Identity
		>
		readonly getConnection: (
			id: string,
		) => Effect.Effect<Models.Connection, Error, Identity>
		readonly prepareConnection: (
			input: string,
		) => Effect.Effect<Models.Draft, Error, Identity>
		readonly createManualConnection: (
			input: Api.ManualConnectionRequest,
		) => Effect.Effect<Models.Connection, Error, Identity>
		readonly getConnectionDraft: (
			id: string,
		) => Effect.Effect<Models.Draft, Error, Identity>
		readonly createConnection: (
			input: Models.Create,
		) => Effect.Effect<Models.Connection, Error, Identity>
	}
>()("@openbot-build/openbot/apps/Connections") {}

export const make: Effect.Effect<
	typeof Connections.Service,
	never,
	| PgClient.PgClient
	| Secrets
	| Discovery.Discovery
	| Discovery.Rules
	| Probe
	| Governance
	| IndexWork
	| Crypto.Crypto
	| Authorization.Auth
> = Effect.gen(function* () {
	const checks = yield* Check.make
	const governance = yield* Governance
	const crypto = yield* Crypto.Crypto
	const db = yield* Db.make
	const secrets = yield* Secrets
	const index = yield* IndexWork
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const probe = yield* Probe
	const project = Effect.fn("Apps.projectConnection")(function* (
		owner: string,
		stored: StoredConnection,
		restrictions?: Effect.Success<typeof governance.snapshot>,
	) {
		const connection = stored.connection
		const app = yield* StoredConnections.getApp(db, owner, connection.cardUrl)
		const remote = app.card.remotes?.[connection.remoteIndex]
		const requirements = remote === undefined ? [] : rules.requirements(remote)
		const values = Redacted.value(connection.configuration)
		const initial: Readonly<Record<string, string>> = {}
		const configuration = Arr.reduce(requirements, initial, (out, field) => {
			const value = values[field.key]
			return field.isSecret === false && value !== undefined
				? { ...out, [field.key]: value }
				: out
		})
		const availability = Match.value(connection.state).pipe(
			Match.when(
				"NeedsRevalidation",
				() => ({ _tag: "NeedsRevalidation" }) as const,
			),
			Match.when(
				"CleanupPending",
				() =>
					stored.verification ??
					({ _tag: "CleanupPending", stage: "Connection" } as const),
			),
			Match.orElse(() =>
				Match.value(connection.authorization).pipe(
					Match.tag(
						"Unprotected",
						() => stored.verification ?? ({ _tag: "Unverified" } as const),
					),
					Match.tag(
						"Authorized",
						() => stored.verification ?? ({ _tag: "Unverified" } as const),
					),
					Match.tag(
						"AuthorizationFailed",
						() => ({ _tag: "AuthorizationExpired" }) as const,
					),
					Match.orElse(
						(auth) =>
							({ _tag: "PendingAuthorization", scopes: auth.scopes }) as const,
					),
				),
			),
		)

		return {
			id: ConnectionId.make(connection.connectionId),
			name: stored.name,
			cardUrl: app.cardUrl,
			card: app.card,
			sources: app.sources,
			endpoint: remote?.url ?? "",
			remoteIndex: connection.remoteIndex,
			configuration,
			enabled: connection.state === "Enabled",
			revision: stored.revision,
			availability: Option.match(
				HashMap.get(
					restrictions ?? (yield* governance.snapshot),
					new URL(connection.cardUrl).href,
				),
				{
					onNone: () => availability,
					onSome: (restriction) =>
						({ _tag: "Restricted", restriction }) as const,
				},
			),
		}
	})
	const owner = Effect.map(Identity, ownerKey)
	const getConnection = Effect.fn("Apps.getConnection")(function* (id: string) {
		const key = yield* owner
		return yield* project(
			key,
			yield* StoredConnections.get(db, secrets, key, id),
		)
	})
	const getDraft = Effect.fn("Apps.getConnectionDraft")(function* (id: string) {
		const row = (yield* db
			.select()
			.from(appDrafts)
			.where(StoredConnections.draftWhere(yield* owner, id))
			.pipe(
				Failures.replace(
					"OpenBot could not read an App connection draft.",
					() => ExperienceStorageUnavailable.make({}),
				),
			))[0]
		if (row === undefined) return yield* ExperienceNotFound.make({ id })
		const draft = yield* Schema.decodeEffect(StoredConnections.draftCodec)(
			row.body,
		).pipe(
			Failures.replace(
				"OpenBot could not decode a stored App connection draft.",
				() => ExperienceStorageUnavailable.make({}),
			),
		)
		if (draft.expiresAt <= (yield* Clock.currentTimeMillis))
			return yield* Api.ConnectionConflict.make({
				reason: "DraftExpired",
				message: "This draft expired. Discover the App again.",
			})
		return draft
	})
	return Connections.of({
		getConnection,
		listConnections: Effect.gen(function* () {
			const caller = yield* Identity
			const key = ownerKey(caller)
			const allowed = yield* checks
				.filter(caller, {
					action: "read",
					kind: "Connection",
					within: ($) =>
						$.and(
							$.eq("organizationId", caller.organizationId),
							$.eq("ownerUserId", caller.userId),
						),
				})
				.pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: sql`${caller.organizationId}`,
							ownerUserId: sql`${caller.userId}`,
							id: appConnections.id,
						}),
					),
				)
			const restrictions = yield* governance.snapshot
			return yield* Effect.forEach(
				yield* StoredConnections.list(db, secrets, key, allowed),
				(row) => project(key, row, restrictions),
			)
		}),
		prepareConnection: Effect.fn("Apps.prepareConnection")(function* (input) {
			const result = yield* DiscoveryService.discover(input).pipe(
				Effect.provideService(Discovery.Discovery, discovery),
			)
			return yield* StoredConnections.saveDraft(db, yield* owner, {
				// A platform without secure random numbers is broken.
				id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
				revision: 0,
				input,
				discovery: result,
				expiresAt: (yield* Clock.currentTimeMillis) + 24 * 60 * 60 * 1000,
			})
		}),
		createManualConnection: Effect.fn("Apps.createManualConnection")(
			function* (input) {
				const key = yield* owner
				const existing = yield* StoredConnections.find(
					db,
					secrets,
					key,
					input.id,
				)
				if (Option.isSome(existing)) return yield* project(key, existing.value)
				yield* governance.check(input.url)
				const configured = yield* ManualConnection.configure(key)(input)
				const protection = yield* probe.check(configured)
				const connection = {
					...configured.connection,
					authorization: protection.requiresAuthorization
						? {
								_tag: "PendingAuthorization" as const,
								resource: input.url,
								scopes: protection.scopes,
							}
						: { _tag: "Unprotected" as const },
				}
				return yield* project(
					key,
					yield* StoredConnections.save(db, secrets, index, key, {
						app: configured.app,
						connection,
						name: input.name,
					}),
				)
			},
		),
		getConnectionDraft: getDraft,
		createConnection: Effect.fn("Apps.confirmConnection")(function* (input) {
			const key = yield* owner
			yield* governance.check(input.cardUrl)
			const existing = yield* StoredConnections.find(
				db,
				secrets,
				key,
				input.draftId,
			)
			if (Option.isSome(existing)) return yield* project(key, existing.value)
			const draft = yield* getDraft(input.draftId)
			if (draft.revision !== input.revision)
				return yield* Api.ConnectionConflict.make({
					reason: "RevisionChanged",
					message: "This draft changed. Refresh it before confirming.",
				})
			const candidates = Match.value(draft.discovery).pipe(
				Match.tag("Single", ({ candidate }) => [candidate]),
				Match.tag("Multiple", ({ candidates }) => candidates),
				Match.exhaustive,
			)
			const found = Arr.findFirst(
				candidates,
				(candidate) => candidate.cardUrl === input.cardUrl,
			)
			if (Option.isNone(found))
				return yield* ExperienceNotFound.make({ id: input.cardUrl })
			const previous = found.value
			const current = yield* discovery
				.refreshCard(previous.cardUrl)
				.pipe(
					Failures.map("The App declaration is not valid", (error) =>
						DiscoveryService.failure(previous.cardUrl, error),
					),
				)
			const prepared = yield* AppConnections.prepare({
				key: { owner: key, connectionId: input.draftId },
				previous,
				current,
				remoteIndex: input.remoteIndex,
				values: input.values,
			}).pipe(
				Effect.provideService(Discovery.Rules, rules),
				Failures.replaceTag(
					"AppError",
					"The App connection requirements changed",
					() =>
						Api.ConnectionConflict.make({
							reason: "CandidateChanged",
							message:
								"The App connection requirements changed. Discover it again and review the current configuration.",
						}),
				),
				// The values come from the caller, so each failure here is a bad input.
				Effect.catchTag(["DiscoveryError", "SchemaError"], (error) =>
					Effect.fail(
						Api.ConnectionConfigurationInvalid.make({
							message:
								"Complete the required configuration for the selected endpoint.",
							keys: DiscoveryService.configurationKeys(
								error,
								current,
								input.remoteIndex,
							),
						}),
					),
				),
			)
			const protection = yield* probe.check(prepared)
			const connection: Store.UserConnection = {
				...prepared.connection,
				authorization: protection.requiresAuthorization
					? {
							_tag: "PendingAuthorization",
							resource: prepared.connection.endpoint,
							scopes: protection.scopes,
						}
					: { _tag: "Unprotected" },
			}
			return yield* project(
				key,
				yield* StoredConnections.save(db, secrets, index, key, {
					app: prepared.app,
					connection,
					name: input.name,
					draftRevision: input.revision,
				}),
			)
		}),
	})
})
export const layer = Layer.effect(Connections, make)
