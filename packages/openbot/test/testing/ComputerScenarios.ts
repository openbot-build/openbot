import { ComputersApi } from "@openbot-build/api"
import type { BotId, ExecutionIdentity } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, HashMap, Layer, Option, Ref } from "effect"
import {
	ComputerCallFailed,
	Machine,
	type Process,
	Provider,
} from "../../src/computers/Computer.ts"
import * as ProcessSink from "../../src/computers/Process.ts"
import { Drivers } from "../../src/computers/Drivers.ts"
import { Computers } from "../../src/computers/Computers.ts"
import { ComputerProviders } from "../../src/computers/ComputerProviders.ts"
import * as Db from "../../src/database/Database.ts"
import {
	computerAccess,
	computerProviders,
	computers,
} from "../../src/database/Schema.ts"

/** A provider that keeps its sandboxes in memory, and writes down what happened. */
export const fakeProvider = Effect.gen(function* () {
	const log = yield* Ref.make<ReadonlyArray<string>>([])
	const files = yield* Ref.make(HashMap.empty<string, string>())
	const next = yield* Ref.make(0)
	/** False while OpenBot cannot reach the provider. */
	const reachable = yield* Ref.make(true)
	const record = (line: string) => Ref.update(log, Arr.append(line))
	const machine = (ref: string) =>
		new Machine({
			shell: {
				start: (request) =>
					Effect.gen(function* () {
						yield* record("run " + ref + " " + request.command)
						const sink = yield* ProcessSink.make
						const process: Process = {
							output: sink.output,
							exit: sink.exit,
							// `cat` gives back its input until Ctrl-D, like the real one.
							write: (data) =>
								data.includes(4)
									? sink
											.push(data.filter((byte) => byte !== 4))
											.pipe(Effect.andThen(sink.end({ code: 0, signal: null })))
									: sink.push(data),
							resize: () => Effect.void,
							signal: (signal) => sink.end({ code: null, signal }),
						}
						if (request.command !== "cat") {
							yield* sink.push(
								new TextEncoder().encode(
									(request.tty ? "tty " : "") + "ran: " + request.command,
								),
							)
							yield* sink.end({ code: 0, signal: null })
						}
						return process
					}),
				read: (path, encoding) =>
					Effect.map(Ref.get(files), (current) => ({
						path,
						encoding,
						content: Option.getOrElse(HashMap.get(current, path), () => ""),
					})),
				write: (file) =>
					Ref.update(files, HashMap.set(file.path, file.content)),
				list: () =>
					Effect.map(Ref.get(files), (current) =>
						Arr.map(Arr.fromIterable(HashMap.keys(current)), (name) => ({
							name,
							kind: "file" as const,
							size: 1,
							modifiedAt: 0,
						})),
					),
				remove: (path) => Ref.update(files, HashMap.remove(path)),
			},
			pausable: {
				pause: record("pause " + ref),
				resume: record("resume " + ref),
			},
			desktop: {
				screenshot: Effect.succeed({
					mediaType: "image/png" as const,
					data: "aW1hZ2U=",
					width: 800,
					height: 600,
				}),
				act: (actions) => record("act " + actions.length),
				stream: Effect.succeed({
					url: "https://view.example.com/" + ref,
					expiresAt: null,
				}),
			},
			ports: {
				open: (port) => Effect.succeed(`https://${port}-${ref}.example.com`),
			},
			state: Effect.succeed("running"),
			destroy: record("destroy " + ref),
		})
	const layer = Layer.succeed(
		Drivers,
		Drivers.of({
			make: () =>
				Effect.succeed(
					new Provider({
						kind: "e2b",
						verify: Effect.void,
						create: () =>
							Effect.gen(function* () {
								const ref =
									"sbx-" + (yield* Ref.getAndUpdate(next, (n) => n + 1))
								yield* record("create " + ref)
								return { ref }
							}),
						attach: (ref) =>
							Effect.flatMap(Ref.get(reachable), (up) =>
								up
									? Effect.succeed(machine(ref))
									: Effect.fail(
											ComputerCallFailed.make({
												message: "The Computer provider could not be reached",
												retry: true,
											}),
										),
							),
					}),
				),
		}),
	)
	return {
		log: Ref.get(log),
		layer,
		reachable: (up: boolean) => Ref.set(reachable, up),
	}
})

/** Set stale and broken rows to check caller limits before row decoding. */
export const prepareListRows = (
	identity: ExecutionIdentity["owner"],
	made: ReadonlyArray<ComputersApi.Computer>,
	bot: BotId,
	providerId: ComputersApi.ComputerProviderId,
	first: ComputersApi.ComputerId,
	second: ComputersApi.ComputerId,
) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		yield* db.insert(computerProviders).values(
			Arr.map([providerId, "cpp_hidden"], (id) => ({
				organizationId: identity.organizationId,
				id,
				ownerUserId: identity.userId,
				kind: "e2b",
				name: id,
				credentials: "unused",
				version: 0,
				createdAt: 0,
				updatedAt: 0,
				hints:
					id === providerId
						? '{"apiKey":null,"plain":{"kind":"e2b","apiKey":""}}'
						: "bad record",
			})),
		)
		yield* db.insert(computerAccess).values(
			Arr.map(made, (computer) => ({
				organizationId: identity.organizationId,
				computerId: computer.id,
				bot,
				grantedBy: identity.userId,
				grantedAt: 0,
			})),
		)
		// A dead node cannot leave a paired machine looking online.
		yield* db
			.update(computers)
			.set({ state: "running" })
			.where(eq(computers.id, first))
		// A hidden broken row must not reach the decoder of a list.
		yield* db
			.update(computers)
			.set({ features: "bad record" })
			.where(
				and(
					eq(computers.organizationId, identity.organizationId),
					eq(computers.id, second),
				),
			)
	})

/** Read Computer views with the same caller chain used by a Bot turn. */
export const queryLists = (
	identity: ExecutionIdentity,
	first: ComputersApi.ComputerId,
) =>
	Effect.gen(function* () {
		const service = yield* Computers
		const providers = yield* ComputerProviders
		return {
			listed: yield* service.list(identity),
			one: yield* service.get({ ...identity.owner, kind: "member" }, first),
			listedAgain: yield* service.list(identity),
			botListed: yield* service.list(identity, identity.botId),
			providers: yield* providers.list(identity),
		}
	})

/** Read the Bot views again after its caller token has been taken away. */
export const queryAfterRevoke = (identity: ExecutionIdentity) =>
	Effect.gen(function* () {
		return {
			computers: yield* (yield* Computers).list(identity, identity.botId),
			providers: yield* (yield* ComputerProviders).list(identity),
		}
	})
