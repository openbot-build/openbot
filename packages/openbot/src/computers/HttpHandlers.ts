import {
	type Caller,
	ComputersApi,
	Identity,
	OpenBotApi,
	type OrganizationApi,
} from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { computerKey } from "../audit/Resources.ts"
import type { ComputerError, Machine } from "./Computer.ts"
import { ComputerProviders } from "./ComputerProviders.ts"
import { checkFile, Computers } from "./Computers.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"
import * as Http from "./Http.ts"
import { Pairings } from "./Pairings.ts"
import { SessionGone, Sessions } from "./Sessions.ts"
import { ownerKey } from "../apps/StoredConnections.ts"

const desktopOf = (machine: Machine) =>
	machine.desktop === undefined
		? Effect.fail(ComputersApi.ComputerUnsupported.make({ feature: "desktop" }))
		: Effect.succeed(machine.desktop)

export const layerProviders = HttpApiBuilder.group(
	OpenBotApi,
	"computerProviders",
	(handlers) =>
		Effect.gen(function* () {
			const providers = yield* ComputerProviders
			const drivers = yield* Drivers
			const audit = yield* AuditLog
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				provider: ComputersApi.ComputerProvider,
				details: Schema.JsonObject,
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: computerKey({
							organizationId: caller.organizationId,
							id: provider.id,
							owner: provider.owner,
							kind: "computer_provider",
						}),
						details,
					})
					.pipe(
						Failures.replace("OpenBot could not write the audit log", () =>
							ComputersApi.ComputersUnavailable.make({}),
						),
					)
			/** The provider must take the key before OpenBot stores it. */
			const verify = (credentials: ComputersApi.ComputerProviderCredentials) =>
				drivers.make(credentials).pipe(
					Effect.flatMap((driver) => driver.verify),
					Effect.tapError(Http.logCause),
					// A failure that can pass, such as a timeout, does not say that the key is wrong.
					Effect.mapError((error) =>
						error.retry
							? ComputersApi.ComputerProviderFailed.make({
									message: error.message,
								})
							: ComputersApi.ComputerInvalid.make({
									message:
										"The provider did not take the key: " + error.message,
								}),
					),
				)
			return handlers
				.handle("listComputerProviders", () =>
					Effect.flatMap(Identity, (caller) => providers.list(caller)),
				)
				.handle("createComputerProvider", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers.create(caller, payload, verify)
						yield* record(caller, "computer_provider.created", provider, {
							kind: provider.kind,
						})
						return provider
					}),
				)
				.handle("getComputerProvider", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						providers.get(caller, params.providerId),
					),
				)
				.handle("updateComputerProvider", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers.update(
							caller,
							params.providerId,
							payload,
							verify,
						)
						yield* record(caller, "computer_provider.updated", provider, {
							keyChanged: payload.credentials !== undefined,
						})
						return provider
					}),
				)
				.handle("deleteComputerProvider", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers.get(
							caller,
							params.providerId,
							"write",
						)
						yield* providers.remove(caller, params.providerId)
						yield* record(caller, "computer_provider.deleted", provider, {})
					}),
				)
		}),
)

export const layer = HttpApiBuilder.group(OpenBotApi, "computers", (handlers) =>
	Effect.gen(function* () {
		const computers = yield* Computers
		const pairings = yield* Pairings
		const sessions = yield* Sessions
		const audit = yield* AuditLog
		const record = (
			caller: Caller,
			action: OrganizationApi.AuditAction,
			computer: Pick<ComputersApi.Computer, "id" | "owner">,
			details: Schema.JsonObject,
		) =>
			audit
				.record({
					organizationId: caller.organizationId,
					action,
					actor: caller,
					resource: computerKey({
						organizationId: caller.organizationId,
						id: computer.id,
						owner: computer.owner,
						kind: "computer",
					}),
					details,
				})
				.pipe(
					Failures.replace("OpenBot could not write the audit log", () =>
						ComputersApi.ComputersUnavailable.make({}),
					),
				)
		/** Work on the machine of a Computer that the caller may use. */
		const onMachine = <A, E>(
			id: string,
			use: (machine: Machine) => Effect.Effect<A, E>,
		) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const { machine } = yield* computers.machine(caller, id)
				return yield* use(machine)
			})
		/** Maps the errors of the machine, and keeps a missing session as it is. */
		const workOn = <A>(effect: Effect.Effect<A, ComputerError | SessionGone>) =>
			effect.pipe(
				Effect.catchIf(
					(error): error is ComputerError => !Schema.is(SessionGone)(error),
					(error) => computers.work(Effect.fail(error)),
				),
			)
		/** The sessions of a caller, on a Computer that the caller may still use. */
		const onSession = <A, E>(
			computerId: string,
			sessionId: string,
			use: (owner: { readonly key: string }) => Effect.Effect<A, E>,
		) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* computers.get(caller, computerId)
				return yield* use({ key: ownerKey(caller) }).pipe(
					Effect.catchIf(
						(error): error is Extract<E, SessionGone> =>
							Schema.is(SessionGone)(error),
						() =>
							Effect.fail(
								ComputersApi.ComputerSessionNotFound.make({ id: sessionId }),
							),
					),
				)
			})
		return handlers
			.handle("listComputers", ({ query }) =>
				Effect.flatMap(Identity, (caller) => computers.list(caller, query.bot)),
			)
			.handle("createComputer", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers.create(caller, payload)
					yield* record(caller, "computer.created", computer, {
						source: computer.source._tag,
					})
					return computer
				}),
			)
			.handle("getComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers.get(caller, params.computerId),
				),
			)
			.handle("updateComputer", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers.update(
						caller,
						params.computerId,
						payload,
					)
					yield* record(caller, "computer.updated", computer, {})
					return computer
				}),
			)
			.handle("deleteComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers.get(
						caller,
						params.computerId,
						"write",
					)
					yield* computers.remove(caller, params.computerId)
					yield* record(caller, "computer.deleted", computer, {})
				}),
			)
			.handle("listComputerBots", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers.bots(caller, params.computerId),
				),
			)
			.handle("grantComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers.get(caller, params.computerId)
					const access = yield* computers.grant(
						caller,
						params.computerId,
						params.botId,
					)
					yield* record(caller, "computer.granted", computer, {
						bot: params.botId,
					})
					return access
				}),
			)
			.handle("revokeComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers.get(caller, params.computerId)
					yield* computers.revoke(caller, params.computerId, params.botId)
					yield* record(caller, "computer.revoked", computer, {
						bot: params.botId,
					})
				}),
			)
			.handle("listComputerUsage", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers.usage(caller, params.computerId),
				),
			)
			.handle("pauseComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers.pause(caller, params.computerId),
				),
			)
			.handle("resumeComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers.resume(caller, params.computerId),
				),
			)
			.handle("setConnectorToken", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const token = yield* computers.setConnectorToken(
						caller,
						params.computerId,
					)
					const computer = yield* computers.get(caller, params.computerId)
					yield* record(caller, "computer.token_changed", computer, {})
					return { token }
				}),
			)
			.handle("exec", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					onMachine(params.computerId, (machine) =>
						computers.work(
							sessions.exec({
								owner: { key: ownerKey(caller) },
								machine,
								request: payload,
							}),
						),
					),
				),
			)
			.handle("writeStdin", ({ params, payload }) =>
				onSession(params.computerId, params.sessionId, (owner) =>
					sessions.write(owner, params.sessionId, payload).pipe(workOn),
				),
			)
			.handle("resizeSession", ({ params, payload }) =>
				onSession(params.computerId, params.sessionId, (owner) =>
					sessions.resize(owner, params.sessionId, payload).pipe(workOn),
				),
			)
			.handle("closeSession", ({ params }) =>
				onSession(params.computerId, params.sessionId, (owner) =>
					sessions.close(owner, params.sessionId).pipe(workOn),
				),
			)
			.handle("readFile", ({ params, query }) =>
				onMachine(params.computerId, (machine) =>
					computers.work(
						machine.shell.read(query.path, query.encoding ?? "utf8"),
					),
				),
			)
			.handle("writeFile", ({ params, payload }) =>
				checkFile(payload).pipe(
					Effect.andThen(
						onMachine(params.computerId, (machine) =>
							computers.work(machine.shell.write(payload)),
						),
					),
				),
			)
			.handle("removeFile", ({ params, query }) =>
				onMachine(params.computerId, (machine) =>
					computers.work(machine.shell.remove(query.path)),
				),
			)
			.handle("listFiles", ({ params, query }) =>
				onMachine(params.computerId, (machine) =>
					computers.work(machine.shell.list(query.path)),
				),
			)
			.handle("openPort", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const { computer, machine } = yield* computers.machine(
						caller,
						params.computerId,
					)
					if (machine.ports === undefined)
						return yield* ComputersApi.ComputerUnsupported.make({
							feature: "ports",
						})
					const url = yield* computers.work(machine.ports.open(params.port))
					yield* record(caller, "computer.port_opened", computer, {
						port: params.port,
					})
					return { port: params.port, url }
				}),
			)
			.handle("takeScreenshot", ({ params }) =>
				onMachine(params.computerId, (machine) =>
					Effect.flatMap(desktopOf(machine), (desktop) =>
						computers.work(desktop.screenshot),
					),
				),
			)
			.handle("useDesktop", ({ params, payload }) =>
				onMachine(params.computerId, (machine) =>
					Effect.flatMap(desktopOf(machine), (desktop) =>
						computers.work(
							Effect.andThen(desktop.act(payload.actions), desktop.screenshot),
						),
					),
				),
			)
			.handle("streamDesktop", ({ params }) =>
				onMachine(params.computerId, (machine) =>
					Effect.flatMap(desktopOf(machine), (desktop) =>
						desktop.stream === undefined
							? Effect.fail(
									ComputersApi.ComputerUnsupported.make({ feature: "stream" }),
								)
							: computers.work(desktop.stream),
					),
				),
			)
			.handle("getComputerPairing", ({ params }) => pairings.get(params.code))
			.handle("approveComputerPairing", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* pairings.approve(caller, params.code, payload)
					yield* record(caller, "computer.paired", computer, {})
					return computer
				}),
			)
			.handle("denyComputerPairing", ({ params }) => pairings.deny(params.code))
	}),
)

const bearer = (header: string | undefined) => {
	const match = /^Bearer\s+(\S+)$/i.exec(header ?? "")
	return match === null ? Option.none() : Option.some(match[1]!)
}

export const layerHooks = HttpApiBuilder.group(
	OpenBotApi,
	"computerHooks",
	(handlers) =>
		Effect.gen(function* () {
			const computers = yield* Computers
			const pairings = yield* Pairings
			const connectors = yield* Connectors
			return handlers
				.handle("startPairing", ({ payload }) => pairings.start(payload))
				.handle("pollPairing", ({ params, headers }) =>
					Option.match(bearer(headers.authorization), {
						onNone: () => Effect.fail(ComputersApi.PairingInvalid.make({})),
						onSome: (secret) => pairings.poll(params.pairingId, secret),
					}),
				)
				.handleRaw("connectComputer", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const token = bearer(request.headers["authorization"])
						if (Option.isNone(token))
							return yield* ComputersApi.ConnectorDenied.make({})
						const found = yield* computers.byToken(token.value)
						if (Option.isNone(found))
							return yield* ComputersApi.ConnectorDenied.make({})
						const { organizationId, id } = found.value
						// The token is good, so a failure here is not a denial. A proxy may drop the upgrade.
						const socket = yield* request.upgrade.pipe(
							Failures.replace("The connector WebSocket did not open", () =>
								ComputersApi.ComputersUnavailable.make({}),
							),
						)
						yield* connectors.serve({
							computerId: id,
							socket,
							online: (hello) =>
								computers.connected(organizationId, id, Option.some(hello)),
							offline: computers.connected(organizationId, id, Option.none()),
						})
						return HttpServerResponse.empty()
					}),
				)
		}),
)
