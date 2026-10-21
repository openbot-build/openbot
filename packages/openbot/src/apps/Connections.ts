import {
	AppDiscoveryFailed,
	ConnectionsApi as Api,
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/api"
import { Discovery, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Redacted,
} from "effect"
import * as DiscoveryService from "./Discovery.ts"
import * as ManualConnection from "./ManualConnection.ts"
import { Governance } from "./Governance.ts"
import { Probe } from "./Probe.ts"
import { Repository, ownerKey, type StoredConnection } from "./Repository.ts"

export type Error =
	| ExperienceInputInvalid
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| AppDiscoveryFailed
	| Api.ConnectionConflict
	| Api.ConnectionConfigurationInvalid
	| Api.AppRestricted
/** Every private operation still explicitly needs the request identity. @effect-expect-leaking Identity */
export class Connections extends Context.Service<
	Connections,
	{
		readonly listConnections: Effect.Effect<
			ReadonlyArray<Api.Connection>,
			Error,
			Identity
		>
		readonly getConnection: (
			id: string,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly prepareConnection: (
			input: string,
		) => Effect.Effect<Api.ConnectionDraft, Error, Identity>
		readonly createManualConnection: (
			input: Api.ManualConnectionRequest,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly getConnectionDraft: (
			id: string,
		) => Effect.Effect<Api.ConnectionDraft, Error, Identity>
		readonly createConnection: (
			input: Api.ConnectionRequest,
		) => Effect.Effect<Api.Connection, Error, Identity>
	}
>()("@openbot-build/openbot/apps/Connections") {}

export const make: Effect.Effect<
	typeof Connections.Service,
	never,
	Repository | Discovery.Discovery | Discovery.Rules | Probe | Governance
> = Effect.gen(function* () {
	const governance = yield* Governance
	const repository = yield* Repository
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const probe = yield* Probe
	const project = Effect.fn("Apps.projectConnection")(function* (
		owner: string,
		stored: StoredConnection,
	) {
		const connection = stored.connection
		const app = yield* repository.getApp(owner, connection.cardUrl)
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
			id: connection.connectionId,
			name: stored.name,
			cardUrl: app.cardUrl,
			card: app.card,
			sources: app.sources,
			endpoint: remote?.url ?? "",
			remoteIndex: connection.remoteIndex,
			configuration,
			enabled: connection.state === "Enabled",
			revision: stored.revision,
			availability: Option.match(governance.find(connection.cardUrl), {
				onNone: () => availability,
				onSome: (restriction) => ({ _tag: "Restricted", restriction }) as const,
			}),
		}
	})
	const owner = Effect.map(Identity, ownerKey)
	const getConnection = Effect.fn("Apps.getConnection")(function* (id: string) {
		const key = yield* owner
		return yield* project(key, yield* repository.get(key, id))
	})
	const getDraft = Effect.fn("Apps.getConnectionDraft")(function* (id: string) {
		const draft = yield* repository.getDraft(yield* owner, id)
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
			const key = yield* owner
			return yield* Effect.forEach(yield* repository.list(key), (row) =>
				project(key, row),
			)
		}),
		prepareConnection: Effect.fn("Apps.prepareConnection")(function* (input) {
			const result = yield* DiscoveryService.discover(input).pipe(
				Effect.provideService(Discovery.Discovery, discovery),
			)
			return yield* repository.saveDraft(yield* owner, {
				id: yield* Effect.sync(() => crypto.randomUUID()),
				revision: 0,
				input,
				discovery: result,
				expiresAt: (yield* Clock.currentTimeMillis) + 24 * 60 * 60 * 1000,
			})
		}),
		createManualConnection: Effect.fn("Apps.createManualConnection")(
			function* (input) {
				const key = yield* owner
				const existing = yield* repository.get(key, input.id).pipe(
					Effect.asSome,
					Effect.catchTag("ExperienceNotFound", () => Effect.succeedNone),
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
					yield* repository.save(key, {
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
			const existing = yield* repository.get(key, input.draftId).pipe(
				Effect.asSome,
				Effect.catchTag("ExperienceNotFound", () => Effect.succeedNone),
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
			const previous = candidates.find(
				(candidate) => candidate.cardUrl === input.cardUrl,
			)
			if (previous === undefined)
				return yield* ExperienceNotFound.make({ id: input.cardUrl })
			const current = yield* discovery.refreshCard(previous.cardUrl).pipe(
				Effect.mapError(() =>
					Api.ConnectionConfigurationInvalid.make({
						message:
							"The App declaration could not be refreshed. Discover it again before confirming.",
						keys: [],
					}),
				),
			)
			if (rules.compare({ previous, current })._tag === "NeedsRevalidation")
				return yield* Api.ConnectionConflict.make({
					reason: "CandidateChanged",
					message:
						"The App connection requirements changed. Discover it again and review the current configuration.",
				})
			const configured = yield* rules
				.configureEndpoint({
					candidate: current,
					index: input.remoteIndex,
					values: input.values,
				})
				.pipe(
					Effect.mapError(() =>
						Api.ConnectionConfigurationInvalid.make({
							message:
								"Complete the required configuration for the selected endpoint.",
							keys:
								current.endpoints
									.find((endpoint) => endpoint.index === input.remoteIndex)
									?.requirements.map((field) => field.key) ?? [],
						}),
					),
				)
			const app = {
				cardUrl: current.cardUrl,
				card: current.card,
				sources: current.sources,
			}
			const provisional: Store.UserConnection = {
				owner: key,
				connectionId: input.draftId,
				cardUrl: current.cardUrl,
				endpoint: configured.url,
				remoteIndex: configured.remoteIndex,
				configuration: Redacted.make(input.values),
				headers: Redacted.make(configured.headers),
				state: "Enabled",
				authorization: { _tag: "Unprotected" },
			}
			const protection = yield* probe.check({ app, connection: provisional })
			const connection: Store.UserConnection = {
				...provisional,
				authorization: protection.requiresAuthorization
					? {
							_tag: "PendingAuthorization",
							resource: configured.url,
							scopes: protection.scopes,
						}
					: { _tag: "Unprotected" },
			}
			return yield* project(
				key,
				yield* repository.save(key, {
					app,
					connection,
					name: input.name,
					draftRevision: input.revision,
				}),
			)
		}),
	})
})
export const layer = Layer.effect(Connections, make)
