import { randomUUID } from "node:crypto"
import { type DeveloperFailure, DeveloperApi as Api } from "@openbot-build/api"
import { Discovery, Document, Store } from "@openbot-build/protocol"
import {
	Clock,
	Context,
	Effect,
	FiberMap,
	Layer,
	Match,
	Option,
	Redacted,
	Schedule,
	Schema,
	Scope,
} from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { DeveloperRepository, type TestRecord } from "./DeveloperRepository.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import { DeveloperTestRuntime } from "./DeveloperTestRuntime.ts"
import { Secrets } from "../secrets/Secrets.ts"

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
const conflict = (reason: string) => Api.DeveloperConflict.make({ reason })
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

export const make = (
	publicOrigin: string,
): Effect.Effect<
	typeof DeveloperTests.Service,
	DeveloperFailure,
	| DeveloperRepository
	| DeveloperAccess
	| DeveloperTestStores
	| DeveloperTestRuntime
	| Discovery.Discovery
	| Discovery.Rules
	| Secrets
	| Scope.Scope
> =>
	Effect.gen(function* () {
		const records = yield* DeveloperRepository
		const access = yield* DeveloperAccess
		const stores = yield* DeveloperTestStores
		const runtime = yield* DeveloperTestRuntime
		const discovery = yield* Discovery.Discovery
		const rules = yield* Discovery.Rules
		const secrets = yield* Secrets
		const fibers = yield* FiberMap.make<string, void, DeveloperFailure>()
		const owned = Effect.fn("DeveloperTests.owned")(function* (
			owner: string,
			id: string,
		) {
			const record = yield* records.tests.get(id)
			if (record.owner !== owner) return yield* Api.DeveloperNotFound.make({})
			return record
		})
		const put = (record: TestRecord) =>
			records.tests.put(
				record.value.id,
				record.owner,
				record.value.cardUrl,
				record,
			)
		const editable = Effect.fn("DeveloperTests.editable")(function* (
			owner: string,
			id: string,
		) {
			const record = yield* owned(owner, id)
			yield* access.authorize(owner, record.value.cardUrl, true)
			if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* conflict("TestExpired")
			if (
				record.value.cleanup === "Pending" ||
				record.value.status === "Cancelled"
			)
				return yield* conflict("TestStopped")
			return record
		})
		const view = Effect.fn("DeveloperTests.view")(function* (
			record: TestRecord,
		) {
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
				? Effect.fail(conflict("TestIdentityConflict"))
				: Effect.succeed(record.value)
		const configure = (
			owner: string,
			id: string,
			values: Readonly<Record<string, string>>,
		) =>
			records.transaction(
				"test:" + id,
				Effect.gen(function* () {
					const record = yield* editable(owner, id)
					if (working(record.value)) return yield* conflict("TestBusy")
					const configured = yield* rules
						.configureEndpoint({
							candidate: record.value.candidate,
							index: record.value.remoteIndex,
							values,
						})
						.pipe(
							Effect.mapError((error) =>
								Api.DeveloperInputInvalid.make({
									keys: Match.value(error).pipe(
										Match.tag("DiscoveryError", (error) =>
											error.issues.flatMap((issue) =>
												issue.fieldPath === undefined ? [] : [issue.fieldPath],
											),
										),
										Match.orElse(
											() =>
												record.value.candidate.endpoints
													.find(
														(endpoint) =>
															endpoint.index === record.value.remoteIndex,
													)
													?.requirements.map(
														(requirement) => requirement.key,
													) ?? [],
										),
									),
									message:
										"Fill in the required configuration fields. Use the formats that this endpoint declares.",
								}),
							),
						)
					if (record.value.authorization !== null)
						return yield* conflict("ClearTestBeforeReconfiguration")
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
					}).pipe(Effect.mapError(() => conflict("InvalidTestConfiguration")))
					yield* stores
						.bind(owner, id)
						.apps.save({ app: record.value.candidate, connection })
						.pipe(Effect.mapError(() => Api.DeveloperUnavailable.make({})))
					const value: Api.ConnectionTest = {
						...record.value,
						endpoint:
							record.value.candidate.endpoints.find(
								(endpoint) => endpoint.index === record.value.remoteIndex,
							)?.remote.url ?? null,
						configurationKeys: Object.keys(values),
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
			const claimed = yield* records.transaction(
				"test:" + id,
				Effect.gen(function* () {
					const record = yield* owned(owner, id)
					const now = yield* Clock.currentTimeMillis
					if (
						record.value.cleanup === "Complete" ||
						(record.cleanupLeaseUntil ?? 0) > now
					)
						return { record, claimed: false }
					const token = yield* Effect.sync(randomUUID)
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
					yield* records.transaction(
						"test:" + id,
						Effect.gen(function* () {
							const latest = yield* owned(owner, id)
							if (latest.cleanupToken !== token)
								return yield* conflict("CleanupLeaseChanged")
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
			return yield* records.transaction(
				"test:" + id,
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
		for (const record of yield* records.tests.list()) {
			if (working(record.value))
				yield* put({
					...record,
					value: {
						...record.value,
						status: "Interrupted",
						reason: "ExecutionInterrupted",
						authorization:
							record.value.authorization?.status === "Exchanging"
								? { ...record.value.authorization, status: "Failed" }
								: record.value.authorization,
					},
				})
		}
		const sweep = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			for (const flow of yield* records.flows.list()) {
				if (
					flow.value.expiresAt > now ||
					(flow.body === "" && flow.callback === null)
				)
					continue
				yield* records.transaction(
					"flow:" + flow.value.flowId,
					Effect.gen(function* () {
						const current = yield* records.flows.get(flow.value.flowId)
						const value: Api.TestAuthorization = [
							"Waiting",
							"Received",
						].includes(current.value.status)
							? { ...current.value, status: "Expired" }
							: current.value
						yield* records.flows.put(
							value.flowId,
							current.owner,
							current.testId,
							{ ...current, consumed: true, body: "", callback: null, value },
						)
						const test = yield* records.tests.find(current.testId)
						if (
							Option.isSome(test) &&
							test.value.value.authorization?.flowId === value.flowId
						)
							yield* put({
								...test.value,
								value: { ...test.value.value, authorization: value },
							})
					}),
				)
			}

			for (const record of yield* records.tests.list()) {
				if (record.value.cleanup === "Complete") continue
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
			}
		})
		return DeveloperTests.of({
			get,
			configure,
			cleanup,
			cancel: cleanup,
			sweep,
			list: (owner) =>
				records.tests
					.list({ owner })
					.pipe(Effect.flatMap((values) => Effect.forEach(values, view))),
			create: Effect.fn("DeveloperTests.create")(function* (owner, input) {
				yield* access.authorize(owner, input.cardUrl, true)
				const current = yield* records.tests.find(input.id)
				if (Option.isSome(current))
					return yield* same(current.value, owner, input)
				const candidate = yield* discovery
					.refreshCard(input.cardUrl)
					.pipe(Effect.mapError(() => conflict("CardUnavailable")))
				if (
					!candidate.endpoints.some(
						(endpoint) => endpoint.index === input.remoteIndex,
					)
				)
					return yield* Api.DeveloperInputInvalid.make({
						message: "Select a declared endpoint.",
					})
				return yield* records.transaction(
					"test:" + input.id,
					Effect.gen(function* () {
						const previous = yield* records.tests.find(input.id)
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
						yield* put({ owner, value })
						return yield* configure(owner, input.id, {}).pipe(
							Effect.catchTag("DeveloperInputInvalid", () =>
								Effect.succeed(value),
							),
						)
					}),
				)
			}),
			run: Effect.fn("DeveloperTests.run")(function* (owner, id) {
				const record = yield* records.transaction(
					"test:" + id,
					Effect.gen(function* () {
						const previous = yield* editable(owner, id)
						if (working(previous.value)) return previous
						if (previous.value.endpoint === null)
							return yield* conflict("ConfigurationRequired")
						const current = yield* discovery
							.refreshCard(previous.value.cardUrl)
							.pipe(Effect.mapError(() => conflict("CardUnavailable")))
						if (
							!Schema.toEquivalence(Schema.UndefinedOr(Document.Remote))(
								previous.value.candidate.card.remotes?.[
									previous.value.remoteIndex
								],
								current.card.remotes?.[previous.value.remoteIndex],
							)
						)
							return yield* conflict("TestTargetChanged")
						const next: TestRecord = {
							...previous,
							value: {
								...previous.value,
								status: "Running",
								stages: previous.value.stages.filter(
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
							records.transaction(
								"test:" + id,
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
													...current.value.stages.filter(
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
													...current.value.stages.filter(
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
													...current.value.stages.filter(
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
						Effect.onInterrupt(() =>
							records
								.transaction(
									"test:" + id,
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
								)
								.pipe(
									// The run stops here, so a failure has no caller to reach.
									// The next restart marks a stuck test as interrupted.
									Effect.catch((error) =>
										Effect.logWarning(
											"Could not mark an interrupted developer test.",
											error,
										),
									),
								),
						),
					),
					{ onlyIfMissing: true },
				)
				return record.value
			}),
			remove: Effect.fn("DeveloperTests.remove")(function* (owner, id) {
				const value = yield* cleanup(owner, id)
				if (value.cleanup !== "Complete")
					return yield* conflict("TestCleanupPending")
				yield* records.tests.remove(id)
			}),
			authorize: (owner, id, input) =>
				records.transaction(
					"test:" + id,
					Effect.gen(function* () {
						const record = yield* editable(owner, id)
						if (working(record.value)) return yield* conflict("TestBusy")
						if (
							record.value.authorization !== null &&
							openAuthorization.includes(record.value.authorization.status) &&
							record.value.authorization.expiresAt >
								(yield* Clock.currentTimeMillis)
						)
							return record.value
						if (record.value.status !== "AwaitingAuthorization")
							return yield* conflict("AuthorizationNotRequired")
						const authorization = yield* runtime.begin(owner, id, input)
						const value = { ...record.value, authorization }
						yield* put({ ...record, value })
						return value
					}),
				),
			complete: Effect.fn("DeveloperTests.complete")(function* (owner, id) {
				const record = yield* records.transaction(
					"test:" + id,
					Effect.gen(function* () {
						const record = yield* editable(owner, id)
						if (record.value.authorization?.status !== "Received")
							return yield* conflict("AuthorizationNotReceived")
						const flow = yield* records.flows.get(
							record.value.authorization.flowId,
						)
						const sealed = flow.callback
						if (
							flow.owner !== owner ||
							flow.testId !== id ||
							sealed === null ||
							flow.consumed
						)
							return yield* conflict("AuthorizationFlowUnavailable")
						if (flow.value.expiresAt <= (yield* Clock.currentTimeMillis))
							return yield* conflict("AuthorizationExpired")
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
				)
				const callback = yield* secrets
					.open(
						record.sealed,
						JSON.stringify([
							"developer-callback",
							owner,
							id,
							record.flow.value.flowId,
						]),
					)
					.pipe(Effect.mapError(() => Api.DeveloperUnavailable.make({})))
				const result = yield* runtime
					.complete(owner, id, record.flow.value.flowId, callback)
					.pipe(Effect.result)
				const current = yield* owned(owner, id)
				const outcome = Match.value(result).pipe(
					Match.tagsExhaustive({
						Success: () => ({
							authorization: "Succeeded" as const,
							status: "Queued" as const,
							cleanupRemote: "Pending" as const,
							reason: null,
						}),
						Failure: () => ({
							authorization: "Failed" as const,
							status: "AwaitingAuthorization" as const,
							cleanupRemote: current.value.cleanupRemote,
							reason: "AuthorizationCouldNotComplete",
						}),
					}),
				)
				const authorization: Api.TestAuthorization = {
					...record.flow.value,
					status: outcome.authorization,
				}
				yield* records.flows.put(authorization.flowId, owner, id, {
					...record.flow,
					consumed: true,
					callback: null,
					body: "",
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
			receive: Effect.fn("DeveloperTests.receive")(function* (input, owners) {
				const url = yield* Effect.try({
					try: () => new URL(input, publicOrigin),
					catch: () => conflict("CallbackMismatch"),
				})
				if (
					url.origin !== publicOrigin ||
					url.pathname !== "/auth/developer/apps/callback" ||
					url.hash !== "" ||
					[...url.searchParams.keys()].some(
						(key) => url.searchParams.getAll(key).length !== 1,
					)
				)
					return yield* conflict("CallbackMismatch")
				const id = url.searchParams.get("state")
				if (id === null) return yield* conflict("CallbackMismatch")
				return yield* records.transaction(
					"flow:" + id,
					Effect.gen(function* () {
						const flow = yield* records.flows.get(id)
						if (Option.exists(owners, (owners) => !owners.includes(flow.owner)))
							return yield* Api.DeveloperNotFound.make({})
						const test = yield* owned(flow.owner, flow.testId)
						if (
							test.value.authorization?.flowId !== id ||
							flow.value.status !== "Waiting" ||
							flow.consumed
						)
							return yield* conflict("AuthorizationAlreadyReceived")
						const now = yield* Clock.currentTimeMillis
						if (flow.value.expiresAt <= now || test.value.expiresAt <= now)
							return yield* conflict("AuthorizationExpired")
						const protocol = yield* stores
							.bind(flow.owner, flow.testId)
							.flows.get({
								key: { owner: flow.owner, connectionId: flow.testId },
								flowId: id,
							})
							.pipe(
								Effect.mapError(() => conflict("AuthorizationFlowUnavailable")),
							)
						const issuer = url.searchParams.get("iss")
						if (
							(issuer !== null && issuer !== protocol.binding.issuer) ||
							(protocol.metadata
								.authorization_response_iss_parameter_supported === true &&
								issuer === null)
						)
							return yield* conflict("CallbackMismatch")
						if (
							!url.searchParams.has("error") &&
							(url.searchParams.get("code") ?? "") === ""
						)
							return yield* conflict("CallbackMismatch")
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
											JSON.stringify([
												"developer-callback",
												flow.owner,
												flow.testId,
												id,
											]),
										)
										.pipe(
											Effect.mapError(() => Api.DeveloperUnavailable.make({})),
										)
								: null
						const value: Api.TestAuthorization = { ...flow.value, status }
						yield* records.flows.put(id, flow.owner, flow.testId, {
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
export const layer = (publicOrigin: string) =>
	Layer.effect(DeveloperTests, make(publicOrigin))
export const layerWorker = Layer.effectDiscard(
	Effect.gen(function* () {
		const tests = yield* DeveloperTests
		yield* tests.sweep.pipe(
			Effect.catch((error) =>
				Effect.logWarning("Developer test cleanup could not complete.", error),
			),
			Effect.repeat(Schedule.spaced("30 seconds")),
			Effect.forkScoped,
		)
	}),
)
