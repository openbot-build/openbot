import {
	type Caller,
	ComputersApi,
	Identity,
	OpenBotApi,
	type OrganizationApi,
} from "@openbot-build/api"
import { Effect, Option, type Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { computerKey } from "../authorization/Policy.ts"
import type { Machine } from "./Computer.ts"
import { ComputerProviders, unavailable } from "./ComputerProviders.ts"
import { Computers } from "./Computers.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"
import { Pairings } from "./Pairings.ts"

const unsupported = (feature: string) =>
	ComputersApi.ComputerUnsupported.make({ feature })

const desktopOf = (machine: Machine) =>
	machine.desktop === undefined
		? Effect.fail(unsupported("desktop"))
		: Effect.succeed(machine.desktop)

export const layerProviders = HttpApiBuilder.group(
	OpenBotApi,
	"computerProviders",
	(handlers) =>
		Effect.gen(function* () {
			const providers = yield* ComputerProviders
			const drivers = yield* Drivers
			const audit = yield* AuditLog
			const services = yield* Effect.context<AuthorizationServices>()
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
					.pipe(Effect.mapError(unavailable))
			/** The provider must take the key before OpenBot stores it. */
			const verify = (credentials: ComputersApi.ComputerProviderCredentials) =>
				drivers.make(credentials).pipe(
					Effect.flatMap((driver) => driver.verify),
					Effect.mapError((error) =>
						ComputersApi.ComputerInvalid.make({
							message: "The provider did not take the key: " + error.message,
						}),
					),
				)
			return handlers
				.handle("listComputerProviders", () =>
					Effect.flatMap(Identity, (caller) =>
						providers.list(caller).pipe(Effect.provideContext(services)),
					),
				)
				.handle("createComputerProvider", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers
							.create(caller, payload, verify)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "computer_provider.created", provider, {
							kind: provider.kind,
						})
						return provider
					}),
				)
				.handle("getComputerProvider", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						providers
							.get(caller, params.providerId)
							.pipe(Effect.provideContext(services)),
					),
				)
				.handle("updateComputerProvider", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers
							.update(caller, params.providerId, payload, verify)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "computer_provider.updated", provider, {
							keyChanged: payload.credentials !== undefined,
						})
						return provider
					}),
				)
				.handle("deleteComputerProvider", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* providers
							.get(caller, params.providerId, "computer_providers.write")
							.pipe(Effect.provideContext(services))
						yield* providers
							.remove(caller, params.providerId)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "computer_provider.deleted", provider, {})
					}),
				)
		}),
)

export const layer = HttpApiBuilder.group(OpenBotApi, "computers", (handlers) =>
	Effect.gen(function* () {
		const computers = yield* Computers
		const pairings = yield* Pairings
		const audit = yield* AuditLog
		const services = yield* Effect.context<AuthorizationServices>()
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
				.pipe(Effect.mapError(unavailable))
		/** Work on the machine of a Computer that the caller may use. */
		const onMachine = <A, E>(
			id: string,
			use: (machine: Machine) => Effect.Effect<A, E>,
		) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const { machine } = yield* computers
					.machine(caller, id)
					.pipe(Effect.provideContext(services))
				return yield* use(machine)
			})
		return handlers
			.handle("listComputers", ({ query }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.list(caller, query.agent)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("createComputer", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers
						.create(caller, payload)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.created", computer, {
						source: computer.source._tag,
					})
					return computer
				}),
			)
			.handle("getComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.get(caller, params.computerId)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("updateComputer", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers
						.update(caller, params.computerId, payload)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.updated", computer, {})
					return computer
				}),
			)
			.handle("deleteComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers
						.get(caller, params.computerId, "computers.write")
						.pipe(Effect.provideContext(services))
					yield* computers
						.remove(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.deleted", computer, {})
				}),
			)
			.handle("listComputerAgents", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.agents(caller, params.computerId)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("grantComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers
						.get(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					const access = yield* computers
						.grant(caller, params.computerId, params.agentId)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.granted", computer, {
						agent: params.agentId,
					})
					return access
				}),
			)
			.handle("revokeComputer", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* computers
						.get(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					yield* computers
						.revoke(caller, params.computerId, params.agentId)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.revoked", computer, {
						agent: params.agentId,
					})
				}),
			)
			.handle("listComputerUsage", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.usage(caller, params.computerId)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("pauseComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.pause(caller, params.computerId)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("resumeComputer", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					computers
						.resume(caller, params.computerId)
						.pipe(Effect.provideContext(services)),
				),
			)
			.handle("setConnectorToken", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const token = yield* computers
						.setConnectorToken(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					const computer = yield* computers
						.get(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					yield* record(caller, "computer.token_changed", computer, {})
					return { token }
				}),
			)
			.handle("runCommand", ({ params, payload }) =>
				onMachine(params.computerId, (machine) =>
					computers.work(machine.shell.run(payload)),
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
				onMachine(params.computerId, (machine) =>
					computers.work(machine.shell.write(payload)),
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
					const { computer, machine } = yield* computers
						.machine(caller, params.computerId)
						.pipe(Effect.provideContext(services))
					if (machine.ports === undefined) return yield* unsupported("ports")
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
						computers.work(desktop.stream),
					),
				),
			)
			.handle("getComputerPairing", ({ params }) => pairings.get(params.code))
			.handle("approveComputerPairing", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const computer = yield* pairings
						.approve(caller, params.code, payload)
						.pipe(Effect.provideContext(services))
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
			const invalid = () => ComputersApi.PairingInvalid.make({})
			const denied = () => ComputersApi.ConnectorDenied.make({})
			return handlers
				.handle("startPairing", ({ payload }) => pairings.start(payload))
				.handle("pollPairing", ({ params, headers }) =>
					Option.match(bearer(headers.authorization), {
						onNone: () => Effect.fail(invalid()),
						onSome: (secret) => pairings.poll(params.pairingId, secret),
					}),
				)
				.handleRaw("connectComputer", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const token = bearer(request.headers["authorization"])
						if (Option.isNone(token)) return yield* denied()
						const found = yield* computers.byToken(token.value)
						if (Option.isNone(found)) return yield* denied()
						const { organizationId, id } = found.value
						const socket = yield* request.upgrade.pipe(Effect.mapError(denied))
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
