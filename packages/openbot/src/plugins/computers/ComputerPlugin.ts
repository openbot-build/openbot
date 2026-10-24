import { BotsApi, ComputersApi } from "@openbot-build/api"
import { Plugin } from "@openbot-build/core"
import {
	Context,
	Data,
	Effect,
	type JsonSchema,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import type { Services as AuthorizationServices } from "../../authorization/Check.ts"
import { Answer, Gate, remember } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import type { Machine } from "../../computers/Computer.ts"
import { ComputerProviders } from "../../computers/ComputerProviders.ts"
import { Computers } from "../../computers/Computers.ts"
import { imageKey, imageOf } from "../../providers/ToolImages.ts"
import { toolJson } from "../ToolJson.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/computers")

/** The tools of this plugin. Their parameters are JSON Schema, like App tools. */
export type Tools = Record<
	string,
	Tool.Dynamic<
		string,
		{
			readonly parameters: JsonSchema.JsonSchema
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		}
	>
>

export const names = {
	list: "openbot_computers_list",
	acquire: "openbot_computers_acquire",
	release: "openbot_computers_release",
	create: "openbot_computers_create",
	pause: "openbot_computers_pause",
	resume: "openbot_computers_resume",
	run: "openbot_computer_run",
	read: "openbot_computer_read_file",
	write: "openbot_computer_write_file",
	files: "openbot_computer_list_files",
	remove: "openbot_computer_remove_file",
	port: "openbot_computer_open_port",
	screenshot: "openbot_computer_screenshot",
	desktop: "openbot_computer_desktop",
} as const

/** Why a Computer tool did not do its work. The model reads the message. */
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
	readonly message: string
}> {}

/** Any tagged error can be shown to the model. */
type Shown = { readonly _tag: string }

const json = toolJson

/** What the model sees of an error. */
const failed = (error: Shown | Schema.SchemaError): Schema.Json => {
	if (typeof error === "object" && error !== null) {
		const tagged = error as {
			readonly _tag?: string
			readonly message?: string
		}
		return json({
			error:
				typeof tagged.message === "string" && tagged.message.length > 0
					? tagged.message
					: (tagged._tag ?? "The call failed."),
		})
	}
	return json({ error: "The call failed." })
}

const Ref = Schema.Struct({ computer: Schema.String })
const WithReason = Schema.Struct({
	computer: Schema.String,
	reason: Schema.optionalKey(Schema.String),
})
const ReleaseInput = Schema.Struct({
	computer: Schema.String,
	destroy: Schema.optionalKey(Schema.Boolean),
	reason: Schema.optionalKey(Schema.String),
})
const CreateInput = Schema.Struct({
	provider: Schema.String,
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
	template: Schema.optionalKey(Schema.String),
	desktop: Schema.optionalKey(Schema.Boolean),
	reason: Schema.optionalKey(Schema.String),
})
const RunInput = Schema.Struct({
	computer: Schema.String,
	...ComputersApi.RunCommandRequest.fields,
})
const ReadInput = Schema.Struct({
	computer: Schema.String,
	path: Schema.String,
	encoding: Schema.optionalKey(ComputersApi.FileEncoding),
})
const WriteInput = Schema.Struct({
	computer: Schema.String,
	...ComputersApi.FileContent.fields,
})
const PathInput = Schema.Struct({
	computer: Schema.String,
	path: Schema.String,
})
const PortInput = Schema.Struct({
	computer: Schema.String,
	port: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(1),
		Schema.isLessThanOrEqualTo(65535),
	),
	reason: Schema.optionalKey(Schema.String),
})
const DesktopInput = Schema.Struct({
	computer: Schema.String,
	actions: Schema.Array(ComputersApi.DesktopAction).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(50),
	),
})

const computerProperty = {
	type: "string",
	description: `The ID of the Computer, from ${names.list}.`,
} as const
const reasonProperty = {
	type: "string",
	description: "Why you need it, in one short sentence.",
} as const

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
				if (part.type === "tool-result" && imageOf(part.result) !== undefined)
					newest = part.id
	if (newest === undefined) return prompt
	return Prompt.fromMessages(
		prompt.content.map((message) => {
			if (message.role !== "tool") return message
			let changed = false
			const content = message.content.map((part) => {
				if (
					part.type !== "tool-result" ||
					part.id === newest ||
					imageOf(part.result) === undefined
				)
					return part
				changed = true
				const rest = { ...(part.result as Record<string, unknown>) }
				delete rest[imageKey]
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

/**
 * Builds the Computer plugin. It gives each Bot tools to get, make and use Computers.
 * It runs inside the Bot plugin, so getting, making and deleting a Computer and
 * opening a port go through the capability gate. Work inside a Computer that the
 * Bot may use needs no review.
 */
export class ComputerPlugin extends Context.Service<
	ComputerPlugin,
	{ readonly plugin: Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/computers/ComputerPlugin") {}

export const make = Effect.gen(function* () {
	const computers = yield* Computers
	const providers = yield* ComputerProviders
	const gate = yield* Gate
	const services = yield* Effect.context<AuthorizationServices>()
	const work = Effect.serviceOption(Work).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	const authorized = <A, E>(
		effect: Effect.Effect<A, E, AuthorizationServices>,
	): Effect.Effect<A, E> => Effect.provideContext(effect, services)

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
				return yield* new ToolFailure({
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
			const { machine } = yield* authorized(
				computers.machine(current.caller, id),
			)
			return yield* use(machine)
		})
	/** The Bots above the current one. A child Bot may ask for their Computers. */
	const parents = (current: typeof Work.Service) => {
		const above = new Set<string>([...current.deciders, ...current.chain.bots])
		above.delete(current.bot.id)
		return Array.from(above, (id) => BotsApi.BotId.make(id))
	}
	/** Asks the gate. A failed check never lets the action run. */
	const ask = (
		input: Parameters<typeof gate.check>[0],
	): Effect.Effect<boolean> =>
		gate.check(input).pipe(
			Effect.map((answer) => answer._tag !== "Allow"),
			Effect.catchCause((cause) =>
				Effect.logWarning("A Computer action could not be checked", cause).pipe(
					Effect.andThen(
						remember(
							input.toolCallId,
							Answer.Deny({ reason: "OpenBot could not check this action." }),
						),
					),
					Effect.as(true),
				),
			),
		)
	const ownerOf = (id: string) =>
		Effect.gen(function* () {
			const current = yield* work
			const computer = yield* authorized(computers.get(current.caller, id))
			return computer.owner
		})

	const tool = <A, I>(
		name: string,
		description: string,
		input: Schema.Codec<A, I>,
		parameters: JsonSchema.JsonSchema,
		handle: (request: A) => Effect.Effect<unknown, Shown>,
		needsApproval?: (
			request: A,
			toolCallId: string,
		) => Effect.Effect<boolean, Shown>,
		readonly = false,
	) => {
		const decode = Schema.decodeUnknownEffect(input)
		const base = { description, parameters, success: Schema.Json }
		const definition =
			needsApproval === undefined
				? Tool.dynamic(name, base)
				: Tool.dynamic(name, {
						...base,
						needsApproval: (raw, call) =>
							decode(raw).pipe(
								Effect.flatMap((request) =>
									needsApproval(request, call.toolCallId),
								),
								// A wrong call fails in its handler, so it does not wait.
								Effect.catchCause(() => Effect.succeed(false)),
							),
					})
		const marked = (
			readonly ? definition.annotate(Tool.Readonly, true) : definition
		) as Tools[string]
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

	const tools = [
		tool(
			names.list,
			"List the Computers that you may use, and the Computers that you may ask for. Also list the Computer providers where you can make a new Computer.",
			Schema.Struct({}),
			{ type: "object", properties: {} },
			() =>
				Effect.gen(function* () {
					const current = yield* work
					const organizationId = current.caller.organizationId
					const mine = yield* computers.heldBy(organizationId, current.bot.id)
					const mineIds = new Set(mine.map((computer) => computer.id))
					const usable = yield* authorized(computers.list(current.caller))
					const fromParents = new Set<string>()
					for (const parent of parents(current))
						for (const computer of yield* computers.heldBy(
							organizationId,
							parent,
						))
							fromParents.add(computer.id)
					const view = (computer: ComputersApi.Computer) => ({
						id: computer.id,
						name: computer.name,
						kind: computer.source._tag === "Connector" ? "machine" : "sandbox",
						state: computer.state,
						features: computer.features,
					})
					const accounts = yield* authorized(providers.list(current.caller))
					return {
						yours: mine.map(view),
						available: usable
							.filter((computer) => !mineIds.has(computer.id))
							.map((computer) => ({
								...view(computer),
								...(fromParents.has(computer.id) ? { usedByParent: true } : {}),
							})),
						providers: accounts.map((provider) => ({
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
			{
				type: "object",
				properties: { computer: computerProperty, reason: reasonProperty },
				required: ["computer"],
			},
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
			{
				type: "object",
				properties: {
					computer: computerProperty,
					destroy: {
						type: "boolean",
						description: "Also delete the Computer itself. Its files are gone.",
					},
					reason: reasonProperty,
				},
				required: ["computer"],
			},
			(request) =>
				Effect.gen(function* () {
					const current = yield* held(request.computer)
					if (request.destroy === true)
						yield* authorized(
							computers.remove(current.caller, request.computer),
						)
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
			{
				type: "object",
				properties: {
					provider: {
						type: "string",
						description: `The ID of a Computer provider, from ${names.list}.`,
					},
					name: { type: "string" },
					template: {
						type: "string",
						description:
							"A template or image of the provider. Leave it out for the default.",
					},
					desktop: {
						type: "boolean",
						description:
							"Ask for a desktop, for screenshots, the mouse and the keyboard.",
					},
					reason: reasonProperty,
				},
				required: ["provider", "name"],
			},
			(request) =>
				Effect.gen(function* () {
					const current = yield* work
					const computer = yield* authorized(
						computers.create(
							current.caller,
							{
								name: request.name,
								source: {
									_tag: "Provider",
									provider: ComputersApi.ComputerProviderId.make(
										request.provider,
									),
									template: request.template ?? null,
								},
								...(request.desktop === undefined
									? {}
									: { desktop: request.desktop }),
							},
							current.bot.id,
						),
					)
					return { id: computer.id, name: computer.name, state: computer.state }
				}),
			(request, toolCallId) =>
				Effect.gen(function* () {
					const current = yield* work
					const provider = yield* authorized(
						providers.get(current.caller, request.provider),
					)
					return yield* ask({
						capability: {
							action: "computers.create",
							target: request.provider,
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
			{
				type: "object",
				properties: { computer: computerProperty },
				required: ["computer"],
			},
			(request) =>
				Effect.gen(function* () {
					const current = yield* held(request.computer)
					const computer = yield* authorized(
						computers.pause(current.caller, request.computer),
					)
					return { state: computer.state }
				}),
		),
		tool(
			names.resume,
			"Resume a paused Computer. Other Computer tools also resume it by themselves.",
			Ref,
			{
				type: "object",
				properties: { computer: computerProperty },
				required: ["computer"],
			},
			(request) =>
				Effect.gen(function* () {
					const current = yield* held(request.computer)
					const computer = yield* authorized(
						computers.resume(current.caller, request.computer),
					)
					return { state: computer.state }
				}),
		),
		tool(
			names.run,
			"Run a shell command on a Computer and wait for it to end.",
			RunInput,
			{
				type: "object",
				properties: {
					computer: computerProperty,
					command: { type: "string", description: "It runs with bash -lc." },
					cwd: { type: "string" },
					env: { type: "object", additionalProperties: { type: "string" } },
					timeout: {
						type: "integer",
						description: "Seconds. The default is 60. The longest is 3600.",
					},
				},
				required: ["computer", "command"],
			},
			({ computer, ...request }) =>
				onMachine(computer, (machine) =>
					computers.work(machine.shell.run(request)),
				),
		),
		tool(
			names.read,
			"Read a file on a Computer.",
			ReadInput,
			{
				type: "object",
				properties: {
					computer: computerProperty,
					path: { type: "string" },
					encoding: {
						type: "string",
						enum: ["utf8", "base64"],
						description: "utf8 for text. base64 for other bytes.",
					},
				},
				required: ["computer", "path"],
			},
			(request) =>
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
			{
				type: "object",
				properties: {
					computer: computerProperty,
					path: { type: "string" },
					content: { type: "string" },
					encoding: { type: "string", enum: ["utf8", "base64"] },
				},
				required: ["computer", "path", "content", "encoding"],
			},
			({ computer, ...file }) =>
				onMachine(computer, (machine) =>
					computers.work(machine.shell.write(file)),
				),
		),
		tool(
			names.files,
			"List the files in a directory of a Computer.",
			PathInput,
			{
				type: "object",
				properties: { computer: computerProperty, path: { type: "string" } },
				required: ["computer", "path"],
			},
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
			{
				type: "object",
				properties: { computer: computerProperty, path: { type: "string" } },
				required: ["computer", "path"],
			},
			(request) =>
				onMachine(request.computer, (machine) =>
					computers.work(machine.shell.remove(request.path)),
				),
		),
		tool(
			names.port,
			"Give a port of a Computer a public HTTPS address. Anyone with the address can use it. It needs a decision.",
			PortInput,
			{
				type: "object",
				properties: {
					computer: computerProperty,
					port: { type: "integer" },
					reason: reasonProperty,
				},
				required: ["computer", "port"],
			},
			(request) =>
				onMachine(request.computer, (machine) =>
					Effect.gen(function* () {
						if (machine.ports === undefined)
							return yield* new ToolFailure({
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
			{
				type: "object",
				properties: { computer: computerProperty },
				required: ["computer"],
			},
			(request) =>
				onMachine(request.computer, (machine) =>
					Effect.gen(function* () {
						if (machine.desktop === undefined)
							return yield* new ToolFailure({
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
			{
				type: "object",
				properties: {
					computer: computerProperty,
					actions: {
						type: "array",
						items: {
							type: "object",
							description:
								'One action, such as {"_tag":"Click","x":10,"y":20}, {"_tag":"Type","text":"hi"} or {"_tag":"Key","keys":["ctrl","c"]}. Other tags: Move, Drag (fromX, fromY, toX, toY), Scroll (x, y, deltaX, deltaY).',
						},
					},
				},
				required: ["computer", "actions"],
			},
			(request) =>
				onMachine(request.computer, (machine) =>
					Effect.gen(function* () {
						const desktop = machine.desktop
						if (desktop === undefined)
							return yield* new ToolFailure({
								message: "This Computer has no desktop.",
							})
						yield* computers.work(desktop.act(request.actions))
						return withImage(yield* computers.work(desktop.screenshot))
					}),
				),
		),
	]

	const plugin = Plugin.make({ id: pluginId })<Tools>(() =>
		Effect.succeed((next, options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const current = yield* Effect.serviceOption(Work)
					if (Option.isNone(current)) return next(options)
					const own = Toolkit.make(...tools.map((entry) => entry.definition))
					const handlers = yield* own.toHandlers(
						Record.fromEntries(
							tools.map((entry) => [entry.definition.name, entry.run] as const),
						),
					)
					const mine = yield* computers
						.heldBy(current.value.caller.organizationId, current.value.bot.id)
						.pipe(Effect.orElseSucceed(() => []))
					const instructions = Prompt.concat(
						options.instructions,
						Prompt.make([
							{
								role: "system",
								content: [
									`You can work on Computers: machines where you run commands, change files and use a desktop. Use ${names.list} to see them.`,
									mine.length === 0
										? "You may use no Computer yet."
										: "Computers that you may use:\n" +
											mine
												.map(
													(computer) =>
														`- ${computer.id}: ${computer.name} (${computer.state})`,
												)
												.join("\n"),
								].join("\n\n"),
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
	return ComputerPlugin.of({ plugin })
})
export const layer = Layer.effect(ComputerPlugin, make)
