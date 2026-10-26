import { type DeveloperFailure, DeveloperApi as Api } from "@openbot-build/api"
import { Discovery, Document, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Exit,
	FiberMap,
	Layer,
	Match,
	Option,
	pipe,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Schedule,
	Schema,
	Scope,
} from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as DiscoveryService from "./Discovery.ts"
import { PgClient } from "@effect/sql-pg"
import { and, asc, eq, isNotNull, lte, ne, or } from "drizzle-orm"
import { developerTestFlows, developerTests } from "../database/Schema.ts"
import * as Rows from "./DeveloperRows.ts"
import type { TestRecord } from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import { DeveloperTestRuntime } from "./DeveloperTestRuntime.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

export class DeveloperTests extends Context.Service<
	DeveloperTests,
	{
		readonly create: (
			owner: string,
			input: {
				readonly id: string
				readonly cardUrl: string
				readonly remoteIndex: number
			},
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly list: (
			owner: string,
		) => Effect.Effect<ReadonlyArray<Api.ConnectionTest>, DeveloperFailure>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly configure: (
			owner: string,
			id: string,
			values: Readonly<Record<string, string>>,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly run: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly cancel: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly cleanup: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly remove: (
			owner: string,
			id: string,
		) => Effect.Effect<void, DeveloperFailure>
		readonly authorize: (
			owner: string,
			id: string,
			input: {
				readonly issuer?: string
				readonly scopes: ReadonlyArray<string>
			},
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly complete: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionTest, DeveloperFailure>
		readonly receive: (
			url: string,
			/** The owners that the signed-in account can act as: one for each active membership. */
			owners: Option.Option<ReadonlyArray<string>>,
		) => Effect.Effect<
			{
				readonly testId: string
				readonly flowId: string
			},
			DeveloperFailure
		>
		readonly sweep: Effect.Effect<void, DeveloperFailure>
	}
>()("@openbot-build/openbot/apps/DeveloperTests") {}
/** Remote cleanup has nothing more to do in these states. */
const remoteCleanupDone: ReadonlyArray<Api.ConnectionTest["cleanupRemote"]> = [
	"NotRequired",
	"Complete",
	"LocalOnly",
]
/** A test authorization in these states can still go on. */
const openAuthorization: ReadonlyArray<Api.TestAuthorization["status"]> = [
	"Waiting",
	"Received",
]
const working = (value: Api.ConnectionTest) =>
	value.status === "Running" || value.authorization?.status === "Exchanging"
/** The JSON text that binds a sealed callback to its test and flow. */
const CallbackBinding = Schema.fromJsonString(Schema.Array(Schema.String))
const callbackBinding = (owner: string, testId: string, flowId: string) =>
	Schema.encodeEffect(CallbackBinding)([
		"developer-callback",
		owner,
		testId,
		flowId,
	]).pipe(Effect.orDie)
/**
 * The App already has a record, so each failure to read its card means that
 * the card is not available now.
 */
const cardUnavailable = Failures.replace("The App card could not be read", () =>
	Api.DeveloperConflict.make({ reason: "CardUnavailable" }),
)
const flowUnavailable = () =>
	Api.DeveloperConflict.make({ reason: "AuthorizationFlowUnavailable" })

export const make: Effect.Effect<
	typeof DeveloperTests.Service,
	DeveloperFailure,
	| PgClient.PgClient
	| DeveloperAccess
	| DeveloperTestStores
	| DeveloperTestRuntime
	| Discovery.Discovery
	| Discovery.Rules
	| Secrets
	| Scope.Scope
	| Crypto.Crypto
	| Settings
> = Effect.gen(function* () {
	const settings = yield* Settings
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	/**
	 * Run the change in one transaction while the row of the test is locked.
	 * A test that does not exist yet has no row to lock.
	 */
	const testTransaction = <A, E, R>(
		id: string,
		effect: Effect.Effect<A, E, R>,
	) =>
		inTransaction(
			Rows.findTest(db, namespace, id, true).pipe(Effect.andThen(effect)),
		)
	/** The rows of the tests whose cleanup is not done. */
	const openTestRows = Rows.stored(
		db
			.select()
			.from(developerTests)
			.where(
				and(
					eq(developerTests.namespace, namespace),
					ne(developerTests.cleanup, "Complete"),
				),
			),
	)
	const access = yield* DeveloperAccess
	const stores = yield* DeveloperTestStores
	const runtime = yield* DeveloperTestRuntime
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const fibers = yield* FiberMap.make<string, void, never>()
	const owned = Effect.fn("DeveloperTests.owned")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* Rows.getTest(db, namespace, id)
		if (record.owner !== owner) return yield* Api.DeveloperNotFound.make({})
		return record
	})
	const put = (record: TestRecord) => Rows.putTest(db, namespace, record)
	const editable = Effect.fn("DeveloperTests.editable")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* owned(owner, id)
		yield* access.authorize(owner, record.value.cardUrl, true)
		if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
			return yield* Api.DeveloperConflict.make({ reason: "TestExpired" })
		if (
			record.value.cleanup === "Pending" ||
			record.value.status === "Cancelled"
		)
			return yield* Api.DeveloperConflict.make({ reason: "TestStopped" })
		return record
	})
	const view = Effect.fn("DeveloperTests.view")(function* (record: TestRecord) {
		const now = yield* Clock.currentTimeMillis
		const value: Api.ConnectionTest =
			record.value.authorization !== null &&
			openAuthorization.includes(record.value.authorization.status) &&
			record.value.authorization.expiresAt <= now
				? {
						...record.value,
						authorization: {
							...record.value.authorization,
							status: "Expired",
						},
					}
				: record.value
		if (yield* access.allows(record.owner, value.cardUrl)) return value
		return {
			...value,
			stages: [],
			configurationKeys: [],
			authorization: null,
		}
	})
	/**
	 * Check that a test can start a sign-in. `open` is true when the test has a
	 * sign-in that can still go on.
	 */
	const authorizable = Effect.fn("DeveloperTests.authorizable")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* editable(owner, id)
		if (working(record.value))
			return yield* Api.DeveloperConflict.make({ reason: "TestBusy" })
		const open =
			record.value.authorization !== null &&
			openAuthorization.includes(record.value.authorization.status) &&
			record.value.authorization.expiresAt > (yield* Clock.currentTimeMillis)
		if (!open && record.value.status !== "AwaitingAuthorization")
			return yield* Api.DeveloperConflict.make({
				reason: "AuthorizationNotRequired",
			})
		return { record, open }
	})
	const get = Effect.fn("DeveloperTests.get")(function* (
		owner: string,
		id: string,
	) {
		return yield* view(yield* owned(owner, id))
	})
	const same = (
		record: TestRecord,
		owner: string,
		input: { readonly cardUrl: string; readonly remoteIndex: number },
	) =>
		record.owner !== owner ||
		record.value.cardUrl !== input.cardUrl ||
		record.value.remoteIndex !== input.remoteIndex
			? Effect.fail(
					Api.DeveloperConflict.make({ reason: "TestIdentityConflict" }),
				)
			: Effect.succeed(record.value)
	const configure = (
		owner: string,
		id: string,
		values: Readonly<Record<string, string>>,
	) =>
		testTransaction(
			id,
			Effect.gen(function* () {
				const record = yield* editable(owner, id)
				if (working(record.value))
					return yield* Api.DeveloperConflict.make({ reason: "TestBusy" })
				const configured = yield* rules
					.configureEndpoint({
						candidate: record.value.candidate,
						index: record.value.remoteIndex,
						values,
					})
					.pipe(
						Effect.mapError((error) =>
							Api.DeveloperInputInvalid.make({
								keys: DiscoveryService.configurationKeys(
									error,
									record.value.candidate,
									record.value.remoteIndex,
								),
								message:
									"Fill in the required configuration fields. Use the formats that this endpoint declares.",
							}),
						),
					)
				if (record.value.authorization !== null)
					return yield* Api.DeveloperConflict.make({
						reason: "ClearTestBeforeReconfiguration",
					})
				const connection = yield* Store.UserConnection.decode({
					owner,
					connectionId: id,
					cardUrl: record.value.cardUrl,
					endpoint: configured.url,
					remoteIndex: configured.remoteIndex,
					configuration: Redacted.make(values),
					headers: Redacted.make(configured.headers),
					state: "Enabled",
					authorization: { _tag: "Unprotected" },
				}).pipe(
					Effect.catchTag("StoreError", () =>
						Effect.fail(
							Api.DeveloperConflict.make({
								reason: "InvalidTestConfiguration",
							}),
						),
					),
				)
				yield* stores
					.bind(owner, id)
					.apps.save({
						app: Store.AppRecord.make(record.value.candidate),
						connection,
					})
					.pipe(
						Effect.catchTag(
							"StoreError",
							(
								error,
							): Effect.Effect<
								never,
								Api.DeveloperNotFound | Api.DeveloperUnavailable
							> =>
								error.reason === "Missing"
									? Effect.fail(Api.DeveloperNotFound.make({}))
									: Effect.fail(error).pipe(
											Failures.replace(
												"Developer test connection could not be saved",
												() => Api.DeveloperUnavailable.make({}),
											),
										),
						),
					)
				const value: Api.ConnectionTest = {
					...record.value,
					endpoint: pipe(
						Arr.findFirst(
							record.value.candidate.endpoints,
							(endpoint) => endpoint.index === record.value.remoteIndex,
						),
						Option.map((endpoint) => endpoint.remote.url),
						Option.getOrNull,
					),
					configurationKeys: Rec.keys(values),
					status: "Queued",
					cleanup: "NotRequired",
					cleanupRemote: "NotRequired",
					cleanupLocal: "Pending",
					authorization: null,
					stages: [
						{
							name: "configuration",
							status: "Passed",
							items: [],
							reason: null,
						},
					],
					reason: null,
				}
				yield* put({ ...record, value })
				return value
			}),
		)
	const cleanup = Effect.fn("DeveloperTests.cleanup")(function* (
		owner: string,
		id: string,
	) {
		const claimed = yield* testTransaction(
			id,
			Effect.gen(function* () {
				const record = yield* owned(owner, id)
				const now = yield* Clock.currentTimeMillis
				if (
					record.value.cleanup === "Complete" ||
					record.cleanupLeaseUntil > now
				)
					return { record, claimed: false }
				// The token exchange decides what remote cleanup must do, so cleanup waits for it.
				if (record.value.authorization?.status === "Exchanging")
					return yield* Api.DeveloperConflict.make({ reason: "TestBusy" })
				const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
				const stopped: TestRecord = {
					...record,
					cleanupToken: token,
					cleanupLeaseUntil: now + 60000,
					value: {
						...record.value,
						status: "Cancelled",
						cleanup: "Pending",
						cleanupLocal: "Pending",
						authorization:
							record.value.authorization === null
								? null
								: { ...record.value.authorization, status: "Cancelled" },
						reason: null,
					},
				}
				yield* put(stopped)
				return { record: stopped, claimed: true }
			}),
		)
		yield* FiberMap.remove(fibers, id)
		if (!claimed.claimed) return claimed.record.value
		const token = claimed.record.cleanupToken
		const result = yield* Effect.gen(function* () {
			const current = yield* owned(owner, id)
			if (!remoteCleanupDone.includes(current.value.cleanupRemote)) {
				const remote = yield* runtime.revoke(owner, id)
				yield* testTransaction(
					id,
					Effect.gen(function* () {
						const latest = yield* owned(owner, id)
						if (latest.cleanupToken !== token)
							return yield* Api.DeveloperConflict.make({
								reason: "CleanupLeaseChanged",
							})
						yield* put({
							...latest,
							value: {
								...latest.value,
								cleanupRemote:
									latest.value.cleanupRemote === "NotRequired"
										? "NotRequired"
										: remote === "Revoked"
											? "Complete"
											: "LocalOnly",
							},
						})
					}),
				)
			}
			yield* runtime.clear(owner, id)
		}).pipe(Effect.result)
		return yield* testTransaction(
			id,
			Effect.gen(function* () {
				const current = yield* owned(owner, id)
				if (current.cleanupToken !== token) return current.value
				const value: Api.ConnectionTest = Match.value(result).pipe(
					Match.tagsExhaustive({
						Success: () => ({
							...current.value,
							cleanup: "Complete" as const,
							cleanupLocal: "Complete" as const,
							configurationKeys: [],
							authorization: null,
							reason: null,
						}),
						Failure: ({ failure }) => ({
							...current.value,
							cleanup: "Pending" as const,
							reason: Match.value(failure).pipe(
								Match.tag("DeveloperConflict", (value) => value.reason),
								Match.orElse(() => "CleanupUnavailable"),
							),
						}),
					}),
				)
				yield* put({ ...current, cleanupLeaseUntil: 0, value })
				return value
			}),
		)
	})
	for (const record of yield* openTestRows.pipe(
		Effect.flatMap((rows) => Effect.forEach(rows, Rows.decodeTest)),
	)) {
		if (working(record.value))
			yield* put({
				...record,
				value: {
					...record.value,
					status: "Interrupted",
					reason: "ExecutionInterrupted",
					...(record.value.authorization?.status === "Exchanging"
						? {
								authorization: {
									...record.value.authorization,
									status: "Failed" as const,
								},
								// The exchange may have stored a token, so cleanup must revoke it.
								cleanupRemote: "Pending" as const,
							}
						: {}),
				},
			})
	}
	const sweep = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const expired = yield* Rows.stored(
			db
				.select()
				.from(developerTestFlows)
				.where(
					and(
						eq(developerTestFlows.namespace, namespace),
						lte(developerTestFlows.expiresAt, now),
						or(
							isNotNull(developerTestFlows.body),
							isNotNull(developerTestFlows.callback),
						),
					),
				)
				.orderBy(asc(developerTestFlows.expiresAt)),
		)
		// One flow or test that fails does not stop the cleanup of the others.
		yield* Effect.forEach(
			expired,
			(flow) =>
				testTransaction(
					flow.testId,
					Effect.gen(function* () {
						const current = yield* Rows.getFlow(db, namespace, flow.flowId)
						const value: Api.TestAuthorization = [
							"Waiting",
							"Received",
						].includes(current.value.status)
							? { ...current.value, status: "Expired" }
							: current.value
						yield* Rows.putFlow(db, namespace, {
							...current,
							consumed: true,
							body: null,
							callback: null,
							value,
						})
						const test = yield* Rows.findTest(db, namespace, current.testId)
						if (
							Option.isSome(test) &&
							test.value.value.authorization?.flowId === value.flowId
						)
							yield* put({
								...test.value,
								value: { ...test.value.value, authorization: value },
							})
					}),
				).pipe(
					Background.logFailure(
						"An expired developer test flow could not be closed.",
					),
					Effect.annotateLogs({ testId: flow.testId, flowId: flow.flowId }),
				),
			{ discard: true },
		)
		yield* Effect.forEach(
			yield* openTestRows,
			(row) =>
				Effect.gen(function* () {
					const record = yield* Rows.decodeTest(row)
					// Cleanup waits for a token exchange. A later sweep cleans the test up.
					if (record.value.authorization?.status === "Exchanging") return
					const allowed = yield* access.allows(
						record.owner,
						record.value.cardUrl,
						true,
					)
					if (
						!allowed ||
						record.value.expiresAt <= now ||
						record.value.cleanup === "Pending"
					)
						yield* cleanup(record.owner, record.value.id)
				}).pipe(
					Background.logFailure("A developer test could not be cleaned up."),
					Effect.annotateLogs({ testId: row.id }),
				),
			{ discard: true },
		)
	})
	return DeveloperTests.of({
		get,
		configure,
		cleanup,
		cancel: cleanup,
		sweep,
		list: (owner) =>
			Rows.stored(
				db
					.select()
					.from(developerTests)
					.where(
						and(
							eq(developerTests.namespace, namespace),
							eq(developerTests.owner, owner),
						),
					)
					.orderBy(developerTests.id),
			).pipe(
				Effect.flatMap((rows) => Effect.forEach(rows, Rows.decodeTest)),
				Effect.flatMap((values) => Effect.forEach(values, view)),
			),
		create: Effect.fn("DeveloperTests.create")(function* (owner, input) {
			yield* access.authorize(owner, input.cardUrl, true)
			const current = yield* Rows.findTest(db, namespace, input.id)
			if (Option.isSome(current))
				return yield* same(current.value, owner, input)
			const candidate = yield* discovery
				.refreshCard(input.cardUrl)
				.pipe(cardUnavailable)
			if (
				!Arr.some(
					candidate.endpoints,
					(endpoint) => endpoint.index === input.remoteIndex,
				)
			)
				return yield* Api.DeveloperInputInvalid.make({
					message: "Select a declared endpoint.",
				})
			return yield* testTransaction(
				input.id,
				Effect.gen(function* () {
					const previous = yield* Rows.findTest(db, namespace, input.id)
					if (Option.isSome(previous))
						return yield* same(previous.value, owner, input)
					yield* access.authorize(owner, input.cardUrl, true)
					const now = yield* Clock.currentTimeMillis
					const value: Api.ConnectionTest = {
						id: input.id,
						cardUrl: input.cardUrl,
						candidate,
						remoteIndex: input.remoteIndex,
						endpoint: null,
						configurationKeys: [],
						issuers: [],
						requestedScopes: [],
						createdAt: now,
						expiresAt: now + 3600000,
						status: "AwaitingConfiguration",
						checkedAt: null,
						cleanup: "NotRequired",
						cleanupRemote: "NotRequired",
						cleanupLocal: "Pending",
						authorization: null,
						stages: [],
						reason: null,
					}
					yield* put({
						owner,
						value,
						resourceMetadataUrl: null,
						cleanupToken: null,
						cleanupLeaseUntil: 0,
					})
					return yield* configure(owner, input.id, {}).pipe(
						Effect.catchTag("DeveloperInputInvalid", () =>
							Effect.succeed(value),
						),
					)
				}),
			)
		}),
		run: Effect.fn("DeveloperTests.run")(function* (owner, id) {
			const record = yield* testTransaction(
				id,
				Effect.gen(function* () {
					const previous = yield* editable(owner, id)
					if (working(previous.value)) return previous
					if (previous.value.endpoint === null)
						return yield* Api.DeveloperConflict.make({
							reason: "ConfigurationRequired",
						})
					const current = yield* discovery
						.refreshCard(previous.value.cardUrl)
						.pipe(cardUnavailable)
					if (
						!Schema.toEquivalence(Schema.UndefinedOr(Document.Remote))(
							previous.value.candidate.card.remotes?.[
								previous.value.remoteIndex
							],
							current.card.remotes?.[previous.value.remoteIndex],
						)
					)
						return yield* Api.DeveloperConflict.make({
							reason: "TestTargetChanged",
						})
					const next: TestRecord = {
						...previous,
						value: {
							...previous.value,
							status: "Running",
							stages: Arr.filter(
								previous.value.stages,
								(stage) => stage.name === "configuration",
							),
							reason: null,
						},
					}
					yield* put(next)
					return next
				}),
			)
			yield* FiberMap.run(
				fibers,
				id,
				runtime.execute(owner, id).pipe(
					Effect.flatMap((result) =>
						testTransaction(
							id,
							Effect.gen(function* () {
								const current = yield* owned(owner, id)
								if (current.value.status !== "Running") return
								const checkedAt = yield* Clock.currentTimeMillis
								const value: Api.ConnectionTest = Match.value(result).pipe(
									Match.tagsExhaustive({
										Completed: (result) => ({
											...current.value,
											checkedAt,
											status: "Succeeded" as const,
											stages: [
												...Arr.filter(
													current.value.stages,
													(stage) => stage.name === "configuration",
												),
												...result.stages,
											],
										}),
										Failed: (result) => ({
											...current.value,
											checkedAt,
											status: "Failed" as const,
											stages: [
												...Arr.filter(
													current.value.stages,
													(stage) => stage.name === "configuration",
												),
												...result.stages,
											],
											reason: result.reason,
										}),
										AwaitingAuthorization: (result) => ({
											...current.value,
											checkedAt,
											status: "AwaitingAuthorization" as const,
											issuers: result.issuers,
											requestedScopes: result.scopes,
											stages: [
												...Arr.filter(
													current.value.stages,
													(stage) => stage.name === "configuration",
												),
												...result.stages,
											],
										}),
									}),
								)
								yield* put({
									...current,
									value,
									...Match.value(result).pipe(
										Match.tag(
											"AwaitingAuthorization",
											({ resourceMetadataUrl }) =>
												resourceMetadataUrl === undefined
													? {}
													: { resourceMetadataUrl },
										),
										Match.orElse(() => ({})),
									),
								})
							}),
						),
					),
					// A run that did not save its result must not stay `Running`.
					Effect.onExit((exit) =>
						Exit.isSuccess(exit)
							? Effect.void
							: testTransaction(
									id,
									Effect.gen(function* () {
										const current = yield* owned(owner, id)
										if (current.value.status === "Running")
											yield* put({
												...current,
												value: {
													...current.value,
													status: "Interrupted",
													reason: "ExecutionInterrupted",
												},
											})
									}),
								).pipe(
									// The test can be gone.
									Effect.catchTag("DeveloperNotFound", () => Effect.void),
									// The run stops here, so a failure has no caller to reach.
									// The next restart marks a stuck test as interrupted.
									Background.logFailure(
										"Could not mark an interrupted developer test.",
									),
								),
					),
					// Nothing joins this fiber, so it logs its own failure.
					Background.logFailure("A developer test run did not finish."),
					Effect.annotateLogs({ testId: id }),
				),
				{ onlyIfMissing: true },
			)
			return record.value
		}),
		remove: Effect.fn("DeveloperTests.remove")(function* (owner, id) {
			const value = yield* cleanup(owner, id)
			if (value.cleanup !== "Complete")
				return yield* Api.DeveloperConflict.make({
					reason: "TestCleanupPending",
				})
			// The flows of the test go with it.
			yield* Rows.stored(
				db
					.delete(developerTests)
					.where(
						and(
							eq(developerTests.namespace, namespace),
							eq(developerTests.id, id),
						),
					),
			)
		}),
		authorize: Effect.fn("DeveloperTests.authorize")(
			function* (owner, id, input) {
				const before = yield* authorizable(owner, id)
				if (before.open) return before.record.value
				// The sign-in starts with network requests, so it runs without the row lock.
				const authorization = yield* runtime.begin(owner, id, input)
				return yield* testTransaction(
					id,
					Effect.gen(function* () {
						const { record, open } = yield* authorizable(owner, id)
						// A sign-in that another call started first wins. The sweep
						// closes the flow of this call when it expires.
						if (open) return record.value
						const value = { ...record.value, authorization }
						yield* put({ ...record, value })
						return value
					}),
				)
			},
		),
		complete: Effect.fn("DeveloperTests.complete")(function* (owner, id) {
			/** True while the token exchange may have stored a token. */
			const exchanged = yield* Ref.make(false)
			/**
			 * Close an authorization that stays `Exchanging` because the steps
			 * after the claim failed or were cut.
			 */
			const closeCut = (flow: Rows.FlowRecord) =>
				Effect.gen(function* () {
					const tokenStored = yield* Ref.get(exchanged)
					yield* testTransaction(
						id,
						Effect.gen(function* () {
							const current = yield* owned(owner, id)
							if (
								current.value.authorization?.status !== "Exchanging" ||
								current.value.authorization.flowId !== flow.value.flowId
							)
								return
							const authorization: Api.TestAuthorization = {
								...flow.value,
								status: "Failed",
							}
							yield* Rows.putFlow(db, namespace, {
								...flow,
								consumed: true,
								callback: null,
								body: null,
								value: authorization,
							})
							yield* put({
								...current,
								value: {
									...current.value,
									status: "AwaitingAuthorization",
									authorization,
									// Cleanup must revoke a token that the exchange stored.
									cleanupRemote: tokenStored
										? "Pending"
										: current.value.cleanupRemote,
									reason: "AuthorizationCouldNotComplete",
								},
							})
						}),
					)
				}).pipe(
					// The test can be gone.
					Effect.catchTag("DeveloperNotFound", () => Effect.void),
					Background.logFailure(
						"Could not record a cut developer test authorization.",
					),
				)
			return yield* Effect.acquireUseRelease(
				testTransaction(
					id,
					Effect.gen(function* () {
						const record = yield* editable(owner, id)
						if (record.value.authorization?.status !== "Received")
							return yield* Api.DeveloperConflict.make({
								reason: "AuthorizationNotReceived",
							})
						const flow = yield* Rows.getFlow(
							db,
							namespace,
							record.value.authorization.flowId,
						)
						const sealed = flow.callback
						if (
							flow.owner !== owner ||
							flow.testId !== id ||
							sealed === null ||
							flow.consumed
						)
							return yield* Api.DeveloperConflict.make({
								reason: "AuthorizationFlowUnavailable",
							})
						if (flow.value.expiresAt <= (yield* Clock.currentTimeMillis))
							return yield* Api.DeveloperConflict.make({
								reason: "AuthorizationExpired",
							})
						yield* put({
							...record,
							value: {
								...record.value,
								authorization: {
									...record.value.authorization,
									status: "Exchanging",
								},
							},
						})
						return { flow, sealed }
					}),
				),
				(record) =>
					Effect.gen(function* () {
						const callback = yield* secrets
							.open(
								record.sealed,
								yield* callbackBinding(owner, id, record.flow.value.flowId),
							)
							.pipe(
								Failures.replace(
									"Developer test callback could not be opened",
									() => Api.DeveloperUnavailable.make({}),
								),
							)
						yield* Ref.set(exchanged, true)
						const result = yield* runtime
							.complete(owner, id, record.flow.value.flowId, callback)
							.pipe(Effect.result)
						// Only an exchange that succeeded stored a token.
						yield* Ref.set(exchanged, Result.isSuccess(result))
						return yield* testTransaction(
							id,
							Effect.gen(function* () {
								const current = yield* owned(owner, id)
								const outcome = Match.value(result).pipe(
									Match.tagsExhaustive({
										Success: () => ({
											authorization: "Succeeded" as const,
											status: "Queued" as const,
											cleanupRemote: "Pending" as const,
											reason: null,
										}),
										Failure: ({ failure }) => ({
											authorization: "Failed" as const,
											status: "AwaitingAuthorization" as const,
											cleanupRemote: current.value.cleanupRemote,
											reason:
												failure._tag === "DeveloperConflict"
													? failure.reason
													: "AuthorizationCouldNotComplete",
										}),
									}),
								)
								const authorization: Api.TestAuthorization = {
									...record.flow.value,
									status: outcome.authorization,
								}
								yield* Rows.putFlow(db, namespace, {
									...record.flow,
									consumed: true,
									callback: null,
									body: null,
									value: authorization,
								})
								if (current.value.status === "Cancelled") return current.value
								const value: Api.ConnectionTest = {
									...current.value,
									status: outcome.status,
									authorization,
									cleanupRemote: outcome.cleanupRemote,
									reason: outcome.reason,
								}
								yield* put({ ...current, value })
								return value
							}),
						)
					}),
				(record, exit) =>
					Exit.isSuccess(exit) ? Effect.void : closeCut(record.flow),
			)
		}),
		receive: Effect.fn("DeveloperTests.receive")(function* (input, owners) {
			const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
				Api.DeveloperUnavailable.make({}),
			)
			if (!URL.canParse(input, publicOrigin))
				return yield* Api.DeveloperConflict.make({
					reason: "CallbackMismatch",
				})
			const url = new URL(input, publicOrigin)
			if (
				url.origin !== publicOrigin ||
				url.pathname !== "/auth/developer/apps/callback" ||
				url.hash !== "" ||
				Arr.some(
					Arr.fromIterable(url.searchParams.keys()),
					(key) => url.searchParams.getAll(key).length !== 1,
				)
			)
				return yield* Api.DeveloperConflict.make({
					reason: "CallbackMismatch",
				})
			const id = url.searchParams.get("state")
			if (id === null)
				return yield* Api.DeveloperConflict.make({
					reason: "CallbackMismatch",
				})
			const found = yield* Rows.getFlow(db, namespace, id)
			return yield* testTransaction(
				found.testId,
				Effect.gen(function* () {
					const flow = yield* Rows.getFlow(db, namespace, id)
					if (Option.exists(owners, (owners) => !owners.includes(flow.owner)))
						return yield* Api.DeveloperNotFound.make({})
					const test = yield* owned(flow.owner, flow.testId)
					if (
						test.value.authorization?.flowId !== id ||
						flow.value.status !== "Waiting" ||
						flow.consumed
					)
						return yield* Api.DeveloperConflict.make({
							reason: "AuthorizationAlreadyReceived",
						})
					const now = yield* Clock.currentTimeMillis
					if (flow.value.expiresAt <= now || test.value.expiresAt <= now)
						return yield* Api.DeveloperConflict.make({
							reason: "AuthorizationExpired",
						})
					const protocol = yield* stores
						.bind(flow.owner, flow.testId)
						.flows.get({
							key: { owner: flow.owner, connectionId: flow.testId },
							flowId: id,
						})
						.pipe(
							Effect.catchTags({
								StoreError: (error) =>
									error.reason === "Unavailable"
										? Effect.fail(error).pipe(
												Failures.replace(
													"Developer test authorization flow could not be read",
													() => Api.DeveloperUnavailable.make({}),
												),
											)
										: Effect.fail(flowUnavailable()),
								AuthorizationError: () => Effect.fail(flowUnavailable()),
							}),
						)
					const issuer = url.searchParams.get("iss")
					if (
						(issuer !== null && issuer !== protocol.binding.issuer) ||
						(protocol.metadata
							.authorization_response_iss_parameter_supported === true &&
							issuer === null)
					)
						return yield* Api.DeveloperConflict.make({
							reason: "CallbackMismatch",
						})
					if (
						!url.searchParams.has("error") &&
						(url.searchParams.get("code") ?? "") === ""
					)
						return yield* Api.DeveloperConflict.make({
							reason: "CallbackMismatch",
						})
					const status = url.searchParams.has("error")
						? url.searchParams.get("error") === "access_denied"
							? ("Cancelled" as const)
							: ("Failed" as const)
						: ("Received" as const)
					const callback =
						status === "Received"
							? yield* secrets
									.seal(
										url.href,
										yield* callbackBinding(flow.owner, flow.testId, id),
									)
									.pipe(
										Failures.replace(
											"Developer test callback could not be sealed",
											() => Api.DeveloperUnavailable.make({}),
										),
									)
							: null
					const value: Api.TestAuthorization = { ...flow.value, status }
					yield* Rows.putFlow(db, namespace, {
						...flow,
						value,
						callback,
						consumed: status !== "Received",
					})
					yield* put({
						...test,
						value: { ...test.value, authorization: value },
					})
					return {
						testId: flow.testId,
						flowId: id,
					}
				}),
			)
		}),
	})
})
export const layer = Layer.effect(DeveloperTests, make)
export const layerWorker = Layer.effectDiscard(
	Effect.gen(function* () {
		const tests = yield* DeveloperTests
		yield* Background.repeat(tests.sweep, {
			schedule: Schedule.spaced("30 seconds"),
			message: "Developer test cleanup could not complete.",
		})
	}),
)
