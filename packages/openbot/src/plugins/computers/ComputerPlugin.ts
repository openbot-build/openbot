import { BotsApi, ComputersApi } from "@openbot-build/api"
import { type Chat, Operation, Plugin, type Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	HashSet,
	Layer,
	Option,
	pipe,
	Predicate,
	Record as Rec,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Answer, Gate, remember } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import type { Machine } from "../../computers/Computer.ts"
import { ComputerProviders } from "../../computers/ComputerProviders.ts"
import { checkFile, Computers } from "../../computers/Computers.ts"
import { Sessions } from "../../computers/Sessions.ts"
import * as ChatHost from "../../chats/ChatHost.ts"
import { hasImage, imageKey } from "../../providers/ToolImages.ts"
import type * as ToolEntry from "../ToolEntry.ts"
import { toolJson } from "../ToolJson.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/computers")

/**
 * The tools of this plugin. Their parameters are JSON Schema, like App tools.
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

/** Any tagged error can be shown to the model. */
type Shown = { readonly _tag: string }

const json = toolJson

/** The text that the model sees for an error: its message, or else its tag. */
const shown = (error: Shown | Schema.SchemaError): string =>
	Predicate.hasProperty(error, "message") &&
	Predicate.isString(error.message) &&
	Str.isNonEmpty(error.message)
		? error.message
		: error._tag

/** What the model sees of an error. */
const failed = (error: Shown | Schema.SchemaError): Schema.Json =>
	json({ error: shown(error) })

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
	name: ComputersApi.CreateComputerRequest.fields.name,
	source: ComputersApi.ComputerSource.cases.Provider.mapFields((fields) => ({
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
	desktop: ComputersApi.CreateComputerRequest.fields.desktop.annotate({
		description:
			"Ask for a desktop, for screenshots, the mouse and the keyboard.",
	}),
	pauseAfter: ComputersApi.CreateComputerRequest.fields.pauseAfter.annotate({
		description:
			"Seconds without work before the Computer pauses, from 60 to 604800. null to never pause.",
	}),
	reason: Reason,
})
const Path = ComputersApi.FileContent.fields.path
const Exec = ComputersApi.ExecRequest.fields
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
	session: ComputersApi.ConnectorSessionId.annotate({
		description: `The session ID from ${names.exec}.`,
	}),
	...ComputersApi.WriteStdinRequest.fields,
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
		ComputersApi.FileEncoding.annotate({
			description: "utf8 for text. base64 for other bytes.",
		}),
	),
})
const WriteInput = Schema.Struct({
	computer: ComputerRef,
	...ComputersApi.FileContent.fields,
})
const PathInput = Schema.Struct({ computer: ComputerRef, path: Path })
const PortInput = Schema.Struct({
	computer: ComputerRef,
	port: ComputersApi.OpenPort.fields.port,
	reason: Reason,
})
const DesktopInput = Schema.Struct({
	computer: ComputerRef,
	actions: Schema.Array(ComputersApi.DesktopAction)
		.check(Schema.isMinLength(1), Schema.isMaxLength(50))
		.annotate({
			description:
				'The actions, in order. One action is, for example, {"_tag":"Click","x":10,"y":20}, {"_tag":"Type","text":"hi"} or {"_tag":"Key","keys":["ctrl","c"]}.',
		}),
})

/** Puts the image of a screenshot in a tool result, so the model sees it. */
const withImage = (screenshot: ComputersApi.Screenshot): Schema.Json =>
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

/** What the Chats of one member give to the Computer plugin. */
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
 * Builds the Computer plugin. It gives each Bot tools to get, make and use Computers.
 * It runs inside the Bot plugin, so getting, making and deleting a Computer and
 * opening a port go through the capability gate. Work inside a Computer that the
 * Bot may use needs no review.
 */
export class ComputerPlugin extends Context.Service<
	ComputerPlugin,
	{ readonly forOwner: (input: ForOwnerInput) => Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/computers/ComputerPlugin") {}

export const make = Effect.gen(function* () {
	const computers = yield* Computers
	const sessions = yield* Sessions
	const providers = yield* ComputerProviders
	const gate = yield* Gate
	// The Bot plugin gives the Work of each Turn, and it runs outside this plugin.
	// The type of a plugin cannot carry that, so each tool reads it when it runs.
	const work = Effect.serviceOption(Work).pipe(
		Effect.flatMap(Effect.fromOption),
	)

	/** The Computer, when the current Bot may use it. */
	const held = (id: string) =>
		Effect.gen(function* () {
			const current = yield* work
			const may = yield* computers.holds(
				current.caller.organizationId,
				current.bot.id,
				id,
			)
			if (!may)
				return yield* ToolFailure.make({
					message: `You may not use the Computer ${id}. Get it first with ${names.acquire}.`,
				})
			return current
		})
	const onMachine = <A, E>(
		id: string,
		use: (machine: Machine) => Effect.Effect<A, E>,
	) =>
		Effect.gen(function* () {
			const current = yield* held(id)
			const { machine } = yield* computers.machine(current.caller, id)
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
					: Effect.logWarning(
							"A Computer action could not be checked",
							cause,
						).pipe(
							Effect.andThen(
								remember(
									input.toolCallId,
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
			const computer = yield* computers.get(current.caller, id)
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
		handle: (request: A) => Effect.Effect<unknown, Shown>,
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
												(Schema.is(ToolFailure)(error)
													? Effect.void
													: Effect.logWarning(
															"A Computer action could not be checked",
															error,
														)
												).pipe(
													Effect.andThen(
														remember(
															call.toolCallId,
															Answer.Deny({ reason: shown(error) }),
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
				Effect.catch((error) => Effect.succeed(failed(error))),
				Effect.catchDefect((defect) =>
					Effect.logWarning("A Computer tool failed", defect).pipe(
						Effect.as(json({ error: "The call failed." })),
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
					const organizationId = current.caller.organizationId
					const mine = yield* computers.heldBy(organizationId, current.bot.id)
					const mineIds = HashSet.fromIterable(
						Arr.map(mine, (computer) => computer.id),
					)
					const usable = yield* computers.list(current.caller)
					const ofParents = yield* Effect.forEach(parents(current), (parent) =>
						computers.heldBy(organizationId, parent),
					)
					const fromParents = HashSet.fromIterable(
						Arr.flatMap(ofParents, (list) =>
							Arr.map(list, (computer) => computer.id),
						),
					)
					const view = (computer: ComputersApi.Computer) => ({
						id: computer.id,
						name: computer.name,
						kind: computer.source._tag === "Connector" ? "machine" : "sandbox",
						state: computer.state,
						features: computer.features,
					})
					const accounts = yield* providers.list(current.caller)
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
						current.caller.organizationId,
						request.computer,
						current.bot.id,
						current.caller.userId,
					)
				}),
			(request, toolCallId) =>
				Effect.gen(function* () {
					const current = yield* work
					if (
						yield* computers.holds(
							current.caller.organizationId,
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
						reason: request.reason ?? `Use the Computer ${request.computer}.`,
						toolCallId,
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
						yield* computers.remove(current.caller, request.computer)
					else
						yield* computers.release(
							current.caller.organizationId,
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
									request.reason ?? `Delete the Computer ${request.computer}.`,
								toolCallId,
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
						current.caller,
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
					return { id: computer.id, name: computer.name, state: computer.state }
				}),
			(request, toolCallId) =>
				Effect.gen(function* () {
					const current = yield* work
					const provider = yield* providers.get(
						current.caller,
						request.source.provider,
					)
					return yield* ask({
						capability: {
							action: "computers.create",
							target: request.source.provider,
						},
						computerOwner: provider.owner,
						reason: request.reason ?? `Make the Computer ${request.name}.`,
						toolCallId,
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
						current.caller,
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
						current.caller,
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
					const owner = { key: current.namespace, chat: current.chat }
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
			({ session, rows, cols, ...request }) =>
				Effect.gen(function* () {
					const current = yield* work
					const owner = { key: current.namespace, chat: current.chat }
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
						const url = yield* computers.work(machine.ports.open(request.port))
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
						toolCallId,
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
						return withImage(yield* computers.work(machine.desktop.screenshot))
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

	const forOwner = (input: ForOwnerInput) => {
		const tools = toolsFor(input)
		return Plugin.make({ id: pluginId })<Tools>(() =>
			Effect.succeed((next, options) =>
				Stream.unwrap(
					Effect.gen(function* () {
						// Only a Turn of a Bot can use Computers. The Bot plugin gives its Work.
						const current = yield* Effect.serviceOption(Work)
						if (Option.isNone(current)) return next(options)
						const own = Toolkit.make(
							...Arr.map(tools, (entry) => entry.definition),
						)
						const handlers = yield* own.toHandlers(
							Rec.fromEntries(
								Arr.map(
									tools,
									(entry) => [entry.definition.name, entry.run] as const,
								),
							),
						)
						// The list only helps the Bot. The tools still work without it.
						const mine = yield* computers
							.heldBy(current.value.caller.organizationId, current.value.bot.id)
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning(
										"OpenBot could not list the Computers of a Bot",
										error,
									).pipe(Effect.as([])),
								),
							)
						const instructions = Prompt.concat(
							options.instructions,
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
						const incoming = options.transformPrompt
						return next({
							...options,
							instructions,
							transformPrompt: (prompt) =>
								(incoming === undefined
									? Effect.succeed(prompt)
									: incoming(prompt)
								).pipe(Effect.map(keepNewestImage)),
							toolkit: Effect.map(options.toolkit, (incoming) =>
								Toolkit.merge(incoming, own),
							),
						}).pipe(Stream.provideContext(handlers))
					}),
				),
			),
		)
	}
	return ComputerPlugin.of({ forOwner })
})
export const layer = Layer.effect(ComputerPlugin, make)
