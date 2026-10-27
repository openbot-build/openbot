import { TestCleanup } from "./TestCleanup.ts"
import { TestCommands, callbackBinding } from "./TestCommands.ts"
import * as Models from "./DeveloperModels.ts"
import { Developers } from "@openbot-build/domain"

import { Discovery, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	pipe,
	Record as Rec,
	Redacted,
} from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as DiscoveryService from "./Discovery.ts"
import { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import { developerTests } from "../database/Schema.ts"
import * as Rows from "./DeveloperRows.ts"
import type { TestRecord } from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"
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
		) => Effect.Effect<Models.ConnectionTest, Developers.Failure>
		readonly list: (
			owner: string,
		) => Effect.Effect<ReadonlyArray<Models.ConnectionTest>, Developers.Failure>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Models.ConnectionTest, Developers.Failure>
		readonly configure: (
			owner: string,
			id: string,
			values: Readonly<Record<string, string>>,
		) => Effect.Effect<Models.ConnectionTest, Developers.Failure>
		readonly receive: (
			url: string,
			/** The owners that the signed-in account can act as: one for each active membership. */
			owners: Option.Option<ReadonlyArray<string>>,
		) => Effect.Effect<
			{
				readonly testId: string
				readonly flowId: string
			},
			Developers.Failure
		>
	}
>()("@openbot-build/openbot/apps/DeveloperTests") {}
/** A test authorization in these states can still go on. */
const openAuthorization: ReadonlyArray<Developers.TestAuthorization["status"]> =
	["Waiting", "Received"]
const working = (value: Models.ConnectionTest) =>
	value.status === "Running" ||
	value.status === "PreparingAuthorization" ||
	value.status === "ExchangingAuthorization" ||
	value.authorization?.status === "Exchanging"
/**
 * The App already has a record, so each failure to read its card means that
 * the card is not available now.
 */
const cardUnavailable = Failures.replace("The App card could not be read", () =>
	Developers.DeveloperConflict.make({ reason: "CardUnavailable" }),
)
const flowUnavailable = () =>
	Developers.DeveloperConflict.make({ reason: "AuthorizationFlowUnavailable" })

export const make: Effect.Effect<
	typeof DeveloperTests.Service,
	Developers.Failure,
	| PgClient.PgClient
	| DeveloperAccess
	| DeveloperTestStores
	| TestCleanup
	| TestCommands
	| Discovery.Discovery
	| Discovery.Rules
	| Secrets
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
	const access = yield* DeveloperAccess
	const stores = yield* DeveloperTestStores
	const cleanup = yield* TestCleanup
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const secrets = yield* Secrets
	const commands = yield* TestCommands
	const owned = Effect.fn("DeveloperTests.owned")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* Rows.getTest(db, namespace, id)
		if (record.owner !== owner)
			return yield* Developers.DeveloperNotFound.make({})
		return record
	})
	const put = (record: TestRecord) => Rows.putTest(db, namespace, record)
	const editable = Effect.fn("DeveloperTests.editable")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* owned(owner, id)
		yield* commands.available(owner, id)
		yield* access.authorize(owner, record.value.cardUrl, true)
		if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
			return yield* Developers.DeveloperConflict.make({ reason: "TestExpired" })
		if (
			record.value.cleanup === "Pending" ||
			record.value.status === "Cancelled"
		)
			return yield* Developers.DeveloperConflict.make({ reason: "TestStopped" })
		return record
	})
	const view = Effect.fn("DeveloperTests.view")(function* (record: TestRecord) {
		const now = yield* Clock.currentTimeMillis
		const value: Models.ConnectionTest =
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
			? Effect.fail(
					Developers.DeveloperConflict.make({ reason: "TestIdentityConflict" }),
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
					return yield* Developers.DeveloperConflict.make({
						reason: "TestBusy",
					})
				const configured = yield* rules
					.configureEndpoint({
						candidate: record.value.candidate,
						index: record.value.remoteIndex,
						values,
					})
					.pipe(
						Effect.mapError((error) =>
							Developers.DeveloperInputInvalid.make({
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
					return yield* Developers.DeveloperConflict.make({
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
							Developers.DeveloperConflict.make({
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
								Developers.DeveloperNotFound | Developers.DeveloperUnavailable
							> =>
								error.reason === "Missing"
									? Effect.fail(Developers.DeveloperNotFound.make({}))
									: Effect.fail(error).pipe(
											Failures.replace(
												"Developer test connection could not be saved",
												() => Developers.DeveloperUnavailable.make({}),
											),
										),
						),
					)
				const value: Models.ConnectionTest = {
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
	return DeveloperTests.of({
		get,
		configure,
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
				return yield* Developers.DeveloperInputInvalid.make({
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
					const value: Models.ConnectionTest = {
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
					})
					yield* cleanup.ensure(yield* owned(owner, input.id))
					return yield* configure(owner, input.id, {}).pipe(
						Effect.catchTag("DeveloperInputInvalid", () =>
							get(owner, input.id),
						),
					)
				}),
			)
		}),
		receive: Effect.fn("DeveloperTests.receive")(function* (input, owners) {
			const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
				Developers.DeveloperUnavailable.make({}),
			)
			if (!URL.canParse(input, publicOrigin))
				return yield* Developers.DeveloperConflict.make({
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
				return yield* Developers.DeveloperConflict.make({
					reason: "CallbackMismatch",
				})
			const id = url.searchParams.get("state")
			if (id === null)
				return yield* Developers.DeveloperConflict.make({
					reason: "CallbackMismatch",
				})
			const found = yield* Rows.getFlow(db, namespace, id)
			return yield* testTransaction(
				found.testId,
				Effect.gen(function* () {
					const flow = yield* Rows.getFlow(db, namespace, id)
					if (Option.exists(owners, (owners) => !owners.includes(flow.owner)))
						return yield* Developers.DeveloperNotFound.make({})
					const test = yield* owned(flow.owner, flow.testId)
					if (
						test.value.authorization?.flowId !== id ||
						flow.value.status !== "Waiting" ||
						flow.consumed
					)
						return yield* Developers.DeveloperConflict.make({
							reason: "AuthorizationAlreadyReceived",
						})
					const now = yield* Clock.currentTimeMillis
					if (flow.value.expiresAt <= now || test.value.expiresAt <= now)
						return yield* Developers.DeveloperConflict.make({
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
													() => Developers.DeveloperUnavailable.make({}),
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
						return yield* Developers.DeveloperConflict.make({
							reason: "CallbackMismatch",
						})
					if (
						!url.searchParams.has("error") &&
						(url.searchParams.get("code") ?? "") === ""
					)
						return yield* Developers.DeveloperConflict.make({
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
											() => Developers.DeveloperUnavailable.make({}),
										),
									)
							: null
					const value: Developers.TestAuthorization = { ...flow.value, status }
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
