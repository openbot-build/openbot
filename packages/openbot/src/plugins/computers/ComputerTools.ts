import { Computers as ComputerData } from "@openbot-build/domain"
import {
	Execution,
	executionCallers,
	Bots as BotsApi,
} from "@openbot-build/domain"
import { type Chat, Operation, type Bot, type Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	HashSet,
	Layer,
	pipe,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Answer, Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import type { Machine } from "../../computers/Computer.ts"
import { ComputerProviders } from "../../computers/ComputerProviders.ts"
import { checkFile, Computers } from "../../computers/Computers.ts"
import { Sessions } from "../../computers/Sessions.ts"
import * as ChatHost from "../../chats/ChatHost.ts"
import { hasImage, imageKey } from "../../providers/ToolImages.ts"
import type * as ToolEntry from "../ToolEntry.ts"
import { toolJson } from "../ToolJson.ts"
import * as Report from "../../errors/Report.ts"

/**
 * The Computer tools. Their parameters are JSON Schema, like App tools.
 * Each tool makes its JSON Schema from the Schema that reads its input.
 */
export type Tools = ToolEntry.Tools

export const names = {
	list: "openbot_computers_list",
	acquire: "openbot_computers_acquire",
	release: "openbot_computers_release",
	create: "openbot_computers_create",
	pause: "openbot_computers_pause",
	resume: "openbot_computers_resume",
	exec: "openbot_computer_exec",
	writeStdin: "openbot_computer_write_stdin",
	read: "openbot_computer_read_file",
	write: "openbot_computer_write_file",
	files: "openbot_computer_list_files",
	remove: "openbot_computer_remove_file",
	port: "openbot_computer_open_port",
	screenshot: "openbot_computer_screenshot",
	desktop: "openbot_computer_desktop",
} as const

/** Why a Computer tool did not do its work. The model reads the message. */
export class ToolFailure extends Schema.TaggedError<
	ToolFailure,
	{ readonly brand: unique symbol }
>()("ToolFailure", {
	message: Schema.String,
}) {}

/** A tagged failure is stored before the model gets a safe error. */
type Shown = { readonly _tag: string }

const json = toolJson

/*
 * The input of each tool. Fields take the same form as in the Computer routes, so a
 * change of the API reaches the model too. The descriptions are for the model.
 */
const ComputerRef = Schema.String.annotate({
	description: `The ID of the Computer, from ${names.list}.`,
})
const Reason = Schema.optionalKey(
	Schema.String.annotate({
		description: "Why you need it, in one short sentence.",
	}),
)
/** The model sends these keys in snake_case, like in other command tools that it knows. */
const snakeKeys = {
	yieldTimeMs: "yield_time_ms",
	maxOutputBytes: "max_output_bytes",
} as const

const ListInput = Tool.EmptyParams
const Ref = Schema.Struct({ computer: ComputerRef })
const WithReason = Schema.Struct({ computer: ComputerRef, reason: Reason })
const ReleaseInput = Schema.Struct({
	computer: ComputerRef,
	destroy: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Also delete the Computer itself. Its files are gone.",
		}),
	),
	reason: Reason,
})
/**
 * The fields of the new Computer take the same form as in `CreateComputerRequest`.
 * A Bot makes only sandboxes, so the source is a provider.
 */
const CreateInput = Schema.Struct({
	name: ComputerData.CreateComputerRequest.fields.name,
	source: ComputerData.ComputerSource.cases.Provider.mapFields((fields) => ({
		...fields,
		provider: fields.provider.annotate({
			description: `The ID of a Computer provider, from ${names.list}.`,
		}),
		template: fields.template.annotate({
			description: "A template or image of the provider. null for the default.",
		}),
	})).annotate({
		description:
			"Where the Computer comes from, in the same form as the `source` of a Computer.",
	}),
	desktop: ComputerData.CreateComputerRequest.fields.desktop.annotate({
		description:
			"Ask for a desktop, for screenshots, the mouse and the keyboard.",
	}),
	pauseAfter: ComputerData.CreateComputerRequest.fields.pauseAfter.annotate({
		description:
			"Seconds without work before the Computer pauses, from 60 to 604800. null to never pause.",
	}),
	reason: Reason,
})
const Path = ComputerData.FileContent.fields.path
const Exec = ComputerData.ExecRequest.fields
const ExecInput = Schema.Struct({
	computer: ComputerRef,
	...Exec,
	command: Exec.command.annotate({ description: "It runs with bash -lc." }),
	tty: Exec.tty.annotate({
		description:
			"Give the command a terminal. Then stdout and stderr come together.",
	}),
	yieldTimeMs: Exec.yieldTimeMs.annotate({
		description: "How long to wait for output. The default is 10000.",
	}),
	maxOutputBytes: Exec.maxOutputBytes.annotate({
		description: "The most output to give back. The default is 65536.",
	}),
}).pipe(Schema.encodeKeys(snakeKeys))
const WriteStdinInput = Schema.Struct({
	computer: ComputerRef,
	session: ComputerData.ConnectorSessionId.annotate({
		description: `The session ID from ${names.exec}.`,
	}),
	...ComputerData.WriteStdinRequest.fields,
	rows: Exec.rows.annotate({ description: "A new terminal size, with cols." }),
	cols: Exec.cols,
}).pipe(Schema.encodeKeys(snakeKeys))

/**
 * These tools stay in their Turn. The command tools give their own session IDs, and
 * the others change which Computers the Bot holds.
 */
const foreground = HashSet.make<ReadonlyArray<string>>(
	names.exec,
	names.writeStdin,
	names.acquire,
	names.release,
	names.create,
	names.pause,
	names.resume,
)
const ReadInput = Schema.Struct({
	computer: ComputerRef,
	path: Path,
	encoding: Schema.optionalKey(
		ComputerData.FileEncoding.annotate({
			description: "utf8 for text. base64 for other bytes.",
		}),
	),
})
const WriteInput = Schema.Struct({
	computer: ComputerRef,
	...ComputerData.FileContent.fields,
})
const PathInput = Schema.Struct({ computer: ComputerRef, path: Path })
const PortInput = Schema.Struct({
	computer: ComputerRef,
	port: ComputerData.OpenPort.fields.port,
	reason: Reason,
})
const DesktopInput = Schema.Struct({
	computer: ComputerRef,
	actions: Schema.Array(ComputerData.DesktopAction)
		.check(Schema.isMinLength(1), Schema.isMaxLength(50))
		.annotate({
			description:
				'The actions, in order. One action is, for example, {"_tag":"Click","x":10,"y":20}, {"_tag":"Type","text":"hi"} or {"_tag":"Key","keys":["ctrl","c"]}.',
		}),
})

/** Puts the image of a screenshot in a tool result, so the model sees it. */
const withImage = (screenshot: ComputerData.Screenshot): Schema.Json =>
	json({
		width: screenshot.width,
		height: screenshot.height,
		[imageKey]: { mediaType: screenshot.mediaType, data: screenshot.data },
	})

/**
 * Old screenshots fill the context fast, so the model sees only the newest one.
 * The others become a short note. The number of messages stays the same.
 */
export const keepNewestImage = (prompt: Prompt.Prompt): Prompt.Prompt => {
	let newest: string | undefined
	for (const message of prompt.content)
		if (message.role === "tool")
			for (const part of message.content)
				if (part.type === "tool-result" && hasImage(part.result))
					newest = part.id
	if (newest === undefined) return prompt
	return Prompt.fromMessages(
		Arr.map(prompt.content, (message) => {
			if (message.role !== "tool") return message
			let changed = false
			const content = Arr.map(message.content, (part) => {
				if (
					part.type !== "tool-result" ||
					part.id === newest ||
					!hasImage(part.result)
				)
					return part
				changed = true
				const rest = Rec.remove(part.result, imageKey)
				return Prompt.toolResultPart({
					id: part.id,
					name: part.name,
					isFailure: part.isFailure,
					providerExecuted: part.providerExecuted,
					result: { ...rest, note: "An older screenshot. It is not shown." },
				})
			})
			return changed ? Prompt.makeMessage("tool", { content }) : message
		}),
	)
}

/** The Chat commands used by the Computer tools. */
interface ForOwnerInput {
	/** Tells a Chat that a command of one of its sessions ended. */
	readonly notify: (
		chat: Chat.Id,
		notice: {
			readonly text: string
			readonly ref: string
			readonly author: Turn.Author
		},
	) => Effect.Effect<void>
}

/**
 * Registers tools to get, make and use Computers with the identity of the Turn.
 * Getting, making and deleting a Computer and opening a port go through the
 * capability gate. Work inside a Computer that the
 * Bot may use needs no review.
 */
export class ComputerTools extends Context.Service<
	ComputerTools,
	{
		readonly register: (
			input: ForOwnerInput,
		) => Effect.Effect<Bot.ToolRegistration<Tools>, never, Work>
		/** Restore one tool without reading the list used in model instructions. */
		readonly restore: (
			input: ForOwnerInput,
			name: string,
			work: typeof Work.Service,
		) => Effect.Effect<Bot.ToolRegistration<Tools>>
	}
>()("@openbot-build/openbot/plugins/computers/ComputerTools") {}

export const make = Effect.gen(function* () {
	const report = yield* Report.make
	const computers = yield* Computers
	const sessions = yield* Sessions
	const providers = yield* ComputerProviders
	const gate = yield* Gate
	const register = (input: ForOwnerInput, selected?: string) =>
		Effect.gen(function* () {
			const current = yield* Work
			const work = Effect.succeed(current)

			/** The Computer, when the current Bot may use it. */
			const held = (id: string) =>
				Effect.gen(function* () {
					const current = yield* work
					const may = yield* computers.holds(
						current.identity.actor.organizationId,
						current.bot.id,
						id,
					)
					if (!may) return yield* Execution.Forbidden.make({})
					// A held Computer still needs every later caller's current right to use it.
					for (const caller of executionCallers(current.identity)) {
						if (caller === current.identity.actor) continue
						yield* computers.get(caller, id, "use")
					}
					return current
				})
			const onMachine = <A, E>(
				id: string,
				use: (machine: Machine) => Effect.Effect<A, E>,
			) =>
				Effect.gen(function* () {
					const current = yield* held(id)
					const { machine } = yield* computers.machine(current.identity, id)
					return yield* use(machine)
				})
			/** The Bots above the current one. A child Bot may ask for their Computers. */
			const parents = (current: typeof Work.Service) =>
				pipe(
					Arr.appendAll(current.deciders, current.chain.bots),
					Arr.dedupe,
					Arr.filter((id) => id !== current.bot.id),
					Arr.map((id) => BotsApi.BotId.make(id)),
				)
			/** Asks the gate. A failed check never lets the action run. */
			const ask = (
				input: Parameters<typeof gate.check>[0],
			): Effect.Effect<boolean> =>
				gate.check(input).pipe(
					Effect.map((answer) => answer._tag !== "Allow"),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: report("A Computer action could not be checked", cause).pipe(
									Effect.andThen(
										gate.remember(
											input.site.main,
											Answer.Deny({
												reason: "OpenBot could not check this action.",
											}),
										),
									),
									Effect.as(true),
								),
					),
				)
			const ownerOf = (id: string) =>
				Effect.gen(function* () {
					const current = yield* work
					const computer = yield* computers.get(current.identity.actor, id)
					return computer.owner
				})

			/**
			 * Makes a tool. Its JSON Schema comes from `input`, the Schema that reads its input.
			 * `needsApproval` runs before the handler. When it fails, the action never runs:
			 * the Turn keeps a Deny for the call, so no other check can allow it.
			 */
			const tool = <A, I>(
				name: string,
				description: string,
				input: Schema.Codec<A, I>,
				handle: (
					request: A,
				) => Effect.Effect<unknown, Shown | Execution.Failure>,
				needsApproval?: (
					request: A,
					toolCallId: string,
				) => Effect.Effect<boolean, Shown>,
				readonly = false,
			) => {
				const decode = Schema.decodeUnknownEffect(input)
				const base = {
					description,
					parameters: Tool.getJsonSchemaFromSchema(input),
					success: Schema.Json,
					failure: Execution.Failure,
				}
				const definition =
					needsApproval === undefined
						? Tool.dynamic(name, base)
						: Tool.dynamic(name, {
								...base,
								needsApproval: (raw, call) =>
									decode(raw).pipe(
										Effect.matchEffect({
											// A wrong call fails in its handler with the same error, so it does not wait.
											onFailure: () => Effect.succeed(false),
											onSuccess: (request) =>
												needsApproval(request, call.toolCallId).pipe(
													Effect.catch((error) =>
														report(
															"A Computer action could not be checked",
															error,
														).pipe(
															Effect.flatMap((failure) =>
																gate.remember(
																	call.toolCallId,
																	Answer.Deny({
																		reason: `${failure.category} (${failure.errorId})`,
																	}),
																),
															),
															Effect.as(true),
														),
													),
												),
										}),
									),
							})
				const read = readonly
					? definition.annotate(Tool.Readonly, true)
					: definition
				const marked = HashSet.has(foreground, name)
					? read.annotate(Operation.Budget, "foreground")
					: read
				const run = (raw: unknown) =>
					decode(raw).pipe(
						Effect.flatMap(handle),
						Effect.map((value) =>
							value === undefined ? json({ done: true }) : json(value),
						),
						Effect.catchIf(
							(error): error is Shown | Schema.SchemaError =>
								!Schema.is(Execution.Failure)(error),
							(error) =>
								report("A Computer tool failed", error).pipe(
									Effect.map((failure) => json({ error: failure })),
								),
						),
					)
				return { definition: marked, run }
			}

			const toolsFor = (input: ForOwnerInput) => [
				tool(
					names.list,
					"List the Computers that you may use, and the Computers that you may ask for. Also list the Computer providers where you can make a new Computer.",
					ListInput,
					() =>
						Effect.gen(function* () {
							const current = yield* work
							const mine = yield* computers.list(
								current.identity,
								current.bot.id,
							)
							const mineIds = HashSet.fromIterable(
								Arr.map(mine, (computer) => computer.id),
							)
							const usable = yield* computers.list(current.identity)
							const ofParents = yield* Effect.forEach(
								parents(current),
								(parent) => computers.list(current.identity, parent),
							)
							const fromParents = HashSet.fromIterable(
								Arr.flatMap(ofParents, (list) =>
									Arr.map(list, (computer) => computer.id),
								),
							)
							const view = (computer: ComputerData.Computer) => ({
								id: computer.id,
								name: computer.name,
								kind:
									computer.source._tag === "Connector" ? "machine" : "sandbox",
								state: computer.state,
								features: computer.features,
							})
							const accounts = yield* providers.list(current.identity)
							return {
								yours: Arr.map(mine, view),
								available: pipe(
									usable,
									Arr.filter((computer) => !HashSet.has(mineIds, computer.id)),
									Arr.map((computer) => ({
										...view(computer),
										...(HashSet.has(fromParents, computer.id)
											? { usedByParent: true }
											: {}),
									})),
								),
								providers: Arr.map(accounts, (provider) => ({
									id: provider.id,
									name: provider.name,
									kind: provider.kind,
								})),
							}
						}),
					undefined,
					true,
				),
				tool(
					names.acquire,
					"Ask for the right to use a Computer that exists, such as a machine of your person or a Computer of the Bot that gave you work. The Bot above you or your person decides.",
					WithReason,
					(request) =>
						Effect.gen(function* () {
							const current = yield* work
							return yield* computers.grantApproved(
								current.identity.actor.organizationId,
								request.computer,
								current.bot.id,
								current.identity.actor.userId,
							)
						}),
					(request, toolCallId) =>
						Effect.gen(function* () {
							const current = yield* work
							if (
								yield* computers.holds(
									current.identity.actor.organizationId,
									current.bot.id,
									request.computer,
								)
							)
								return false
							const owner = yield* ownerOf(request.computer)
							return yield* ask({
								capability: {
									action: "computers.acquire",
									target: request.computer,
								},
								computerOwner: owner,
								reason:
									request.reason ?? `Use the Computer ${request.computer}.`,
								site: { main: toolCallId, path: [] },
							})
						}),
				),
				tool(
					names.release,
					"Give up your right to use a Computer. With destroy, also delete the Computer and its files for everyone. Deleting needs a decision.",
					ReleaseInput,
					(request) =>
						Effect.gen(function* () {
							const current = yield* held(request.computer)
							if (request.destroy === true)
								yield* computers.remove(
									current.identity.actor,
									request.computer,
								)
							else
								yield* computers.release(
									current.identity.actor.organizationId,
									current.bot.id,
									request.computer,
								)
						}),
					(request, toolCallId) =>
						request.destroy !== true
							? Effect.succeed(false)
							: Effect.gen(function* () {
									const owner = yield* ownerOf(request.computer)
									return yield* ask({
										capability: {
											action: "computers.delete",
											target: request.computer,
										},
										computerOwner: owner,
										reason:
											request.reason ??
											`Delete the Computer ${request.computer}.`,
										site: { main: toolCallId, path: [] },
									})
								}),
				),
				tool(
					names.create,
					"Make a new Computer with a Computer provider. It belongs to your person, and you may use it. It needs a decision.",
					CreateInput,
					(request) =>
						Effect.gen(function* () {
							const current = yield* work
							const computer = yield* computers.create(
								current.identity.actor,
								{
									name: request.name,
									source: request.source,
									...(request.desktop === undefined
										? {}
										: { desktop: request.desktop }),
									...(request.pauseAfter === undefined
										? {}
										: { pauseAfter: request.pauseAfter }),
								},
								current.bot.id,
							)
							return {
								id: computer.id,
								name: computer.name,
								state: computer.state,
							}
						}),
					(request, toolCallId) =>
						Effect.gen(function* () {
							const current = yield* work
							const provider = yield* providers.get(
								current.identity.actor,
								request.source.provider,
							)
							return yield* ask({
								capability: {
									action: "computers.create",
									target: request.source.provider,
								},
								computerOwner: provider.owner,
								reason: request.reason ?? `Make the Computer ${request.name}.`,
								site: { main: toolCallId, path: [] },
							})
						}),
				),
				tool(
					names.pause,
					"Pause a Computer that you do not need now. It keeps its files and memory.",
					Ref,
					(request) =>
						Effect.gen(function* () {
							const current = yield* held(request.computer)
							const computer = yield* computers.pause(
								current.identity.actor,
								request.computer,
							)
							return { state: computer.state }
						}),
				),
				tool(
					names.resume,
					"Resume a paused Computer. Other Computer tools also resume it by themselves.",
					Ref,
					(request) =>
						Effect.gen(function* () {
							const current = yield* held(request.computer)
							const computer = yield* computers.resume(
								current.identity.actor,
								request.computer,
							)
							return { state: computer.state }
						}),
				),
				tool(
					names.exec,
					"Start a shell command on a Computer. It waits up to yield_time_ms for the command. When the command still runs then, you get a session ID: use " +
						names.writeStdin +
						" with it to send input and read more output. When it ends later, you get a message with its end. Set tty for programs that need a terminal, such as python3, ssh or top.",
					ExecInput,
					({ computer, ...request }) =>
						Effect.gen(function* () {
							const current = yield* work
							const owner = {
								identity: current.identity,
								chat: current.chat,
								computer,
							}
							return yield* onMachine(computer, (machine) =>
								computers.work(
									sessions.exec({
										owner,
										machine,
										request,
										onEnd: (exit, output) =>
											input.notify(current.chat, {
												text: JSON.stringify({
													computer,
													command: Str.slice(0, 200)(request.command),
													exitCode: exit.code,
													...(exit.failure === undefined
														? {}
														: { failure: exit.failure }),
													signal: exit.signal,
													...(exit.error === undefined
														? {}
														: { error: exit.error }),
													output,
												}),
												ref: computer,
												author: ChatHost.chainAuthor(current.chain),
											}),
									}),
								),
							)
						}),
				),
				tool(
					names.writeStdin,
					"Send text to the stdin of a command session, and read its output since the last call. Send empty chars to only read. C escapes work: \\x03 is Ctrl-C, \\x04 is Ctrl-D (end of input), \\n is Enter.",
					WriteStdinInput,
					({ computer, session, rows, cols, ...request }) =>
						Effect.gen(function* () {
							const current = yield* held(computer)
							yield* computers.get(current.identity.actor, computer, "use")
							const owner = {
								identity: current.identity,
								chat: current.chat,
								computer,
							}
							const gone = () =>
								ToolFailure.make({
									message: `There is no session ${session}. It ended, or it is not one of this Chat.`,
								})
							if (rows !== undefined && cols !== undefined)
								yield* computers.work(
									sessions
										.resize(owner, session, { rows, cols })
										.pipe(Effect.catchTag("SessionGone", () => Effect.void)),
								)
							return yield* sessions.write(owner, session, request).pipe(
								Effect.catchTag("SessionGone", () => Effect.fail(gone())),
								(effect) =>
									Effect.catchIf(
										effect,
										(error): error is Exclude<typeof error, ToolFailure> =>
											!Schema.is(ToolFailure)(error),
										(error) => computers.work(Effect.fail(error)),
									),
							)
						}),
				),
				tool(names.read, "Read a file on a Computer.", ReadInput, (request) =>
					onMachine(request.computer, (machine) =>
						computers.work(
							machine.shell.read(request.path, request.encoding ?? "utf8"),
						),
					),
				),
				tool(
					names.write,
					"Write a file on a Computer. Missing directories are made.",
					WriteInput,
					({ computer, ...file }) =>
						checkFile(file).pipe(
							Effect.andThen(
								onMachine(computer, (machine) =>
									computers.work(machine.shell.write(file)),
								),
							),
						),
				),
				tool(
					names.files,
					"List the files in a directory of a Computer.",
					PathInput,
					(request) =>
						onMachine(request.computer, (machine) =>
							computers.work(machine.shell.list(request.path)),
						),
					undefined,
					true,
				),
				tool(
					names.remove,
					"Remove a file, or a directory with everything in it, on a Computer.",
					PathInput,
					(request) =>
						onMachine(request.computer, (machine) =>
							computers.work(machine.shell.remove(request.path)),
						),
				),
				tool(
					names.port,
					"Give a port of a Computer a public HTTPS address. Anyone with the address can use it. It needs a decision.",
					PortInput,
					(request) =>
						onMachine(request.computer, (machine) =>
							Effect.gen(function* () {
								if (machine.ports === undefined)
									return yield* ToolFailure.make({
										message: "This Computer has no public ports.",
									})
								const url = yield* computers.work(
									machine.ports.open(request.port),
								)
								return { port: request.port, url }
							}),
						),
					(request, toolCallId) =>
						Effect.gen(function* () {
							yield* held(request.computer)
							const owner = yield* ownerOf(request.computer)
							return yield* ask({
								capability: {
									action: "computers.expose",
									target: request.computer,
								},
								computerOwner: owner,
								reason:
									request.reason ??
									`Open the port ${request.port} of the Computer ${request.computer}.`,
								site: { main: toolCallId, path: [] },
							})
						}),
				),
				tool(
					names.screenshot,
					"Take a screenshot of the desktop of a Computer. You see the image.",
					Ref,
					(request) =>
						onMachine(request.computer, (machine) =>
							Effect.gen(function* () {
								if (machine.desktop === undefined)
									return yield* ToolFailure.make({
										message: "This Computer has no desktop.",
									})
								return withImage(
									yield* computers.work(machine.desktop.screenshot),
								)
							}),
						),
					undefined,
					true,
				),
				tool(
					names.desktop,
					"Use the desktop of a Computer: click, move, drag, scroll, type and press keys, in order. Then you see a new screenshot. Coordinates are pixels of the last screenshot.",
					DesktopInput,
					(request) =>
						onMachine(request.computer, (machine) =>
							Effect.gen(function* () {
								const desktop = machine.desktop
								if (desktop === undefined)
									return yield* ToolFailure.make({
										message: "This Computer has no desktop.",
									})
								yield* computers.work(desktop.act(request.actions))
								return withImage(yield* computers.work(desktop.screenshot))
							}),
						),
				),
			]

			const tools = Arr.filter(
				toolsFor(input),
				(entry) => selected === undefined || entry.definition.name === selected,
			)
			const own = Toolkit.make(...Arr.map(tools, (entry) => entry.definition))
			const handlers = yield* own.toHandlers(
				Rec.fromEntries(
					Arr.map(
						tools,
						(entry) => [entry.definition.name, entry.run] as const,
					),
				),
			)
			if (selected !== undefined) return { tools: own.tools, handlers }
			// The list only helps the Bot. The tools still work without it.
			const mine = yield* computers
				.list(current.identity, current.bot.id)
				.pipe(
					Effect.catch((error) =>
						report("OpenBot could not list the Computers of a Bot", error).pipe(
							Effect.as([]),
						),
					),
				)
			const instructions = Prompt.concat(
				Prompt.empty,
				Prompt.make([
					{
						role: "system",
						content: Arr.join(
							[
								`You can work on Computers: machines where you run commands, change files and use a desktop. Use ${names.list} to see them.`,
								mine.length === 0
									? "You may use no Computer yet."
									: "Computers that you may use:\n" +
										pipe(
											mine,
											Arr.map(
												(computer) =>
													`- ${computer.id}: ${computer.name} (${computer.state})`,
											),
											Arr.join("\n"),
										),
							],
							"\n\n",
						),
					},
				]),
			)
			return {
				tools: own.tools,
				handlers,
				instructions,
				transformPrompt: (prompt: Prompt.Prompt) =>
					Effect.succeed(keepNewestImage(prompt)),
			}
		})
	return ComputerTools.of({
		register: (input) => register(input),
		restore: (input, name, work) =>
			register(input, name).pipe(Effect.provideService(Work, work)),
	})
})
export const layer = Layer.effect(ComputerTools, make)
