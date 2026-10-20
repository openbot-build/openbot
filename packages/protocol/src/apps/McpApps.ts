import {
	Array as EffectArray,
	HashSet,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
	Scope,
	Semaphore,
	Match,
	type Option,
} from "effect"
import {
	AppBridge,
	type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import {
	type CallToolResult,
	type Implementation,
} from "@modelcontextprotocol/client"

import type * as Client from "../connections/Client.ts"
import { FrameTransport } from "./FrameBoundary.ts"
import * as App from "../connections/App.ts"
import * as Ui from "./Ui.ts"
import {
	HostActionDenied,
	HostActions,
	State,
	type Source,
	type Session,
} from "./Apps.ts"

const sdk = <A>(call: () => Promise<A>) =>
	Effect.tryPromise({
		try: call,
		catch: () =>
			new Ui.UiError({
				reason: "Protocol",
				issue: "Apps bridge operation failed",
			}),
	})

export type UiClient = Pick<
	Client.Client,
	| "key"
	| "listTools"
	| "callTool"
	| "readResource"
	| "listResources"
	| "listResourceTemplates"
>

/** The Client is already bound to one connection. The bridge never gets a raw SDK Client. */
export const mount = Effect.fn("Apps.mount")(function* (options: {
	readonly container: HTMLElement
	readonly client: UiClient
	readonly tool: string
	readonly arguments?: Schema.JsonObject
	readonly result?: CallToolResult
	readonly hostInfo: Implementation
	readonly hostContext?: McpUiHostContext
	readonly timeoutMs?: number
}) {
	const ui = yield* Ui.Ui
	const actions = yield* HostActions
	const active = yield* App.ConnectionScopes
	const parentScope = yield* Effect.scope
	const context = yield* Effect.context<never>()
	const run = Effect.runPromiseExitWith(context)
	const source: Source = { key: options.client.key, tool: options.tool }
	const state = yield* Ref.make<State>({ _tag: "Loading" })
	const result = yield* Ref.make<CallToolResult | undefined>(options.result)
	const lock = Semaphore.makeUnsafe(1)
	let scope: Scope.Closeable | undefined
	let bridge: AppBridge | undefined
	let ready = Deferred.makeUnsafe<void, Ui.UiError>()
	let args = options.arguments
	let partials: ReadonlyArray<Schema.JsonObject> = []
	let cancellation: string | undefined
	let inputSent = false
	let resultSent = false
	let cancellationSent = false
	let generation = 0
	let disposed = false
	let pendingActions = HashSet.empty<Effect.Effect<void>>()
	let hostContext = options.hostContext ?? {}

	const fail = (error: Ui.UiError) =>
		Effect.gen(function* () {
			if (disposed) return
			return yield* Match.value(yield* Ref.get(state)).pipe(
				Match.not({ _tag: "Failed" }, () =>
					Effect.gen(function* () {
						yield* Ref.set(state, {
							_tag: "Failed",
							reason: error.reason,
							issue: error.issue,
						})
						yield* Deferred.fail(ready, error)
						if (scope !== undefined) yield* Scope.close(scope, Exit.void)
					}),
				),
				Match.orElse(() => Effect.void),
			)
		})
	const flush = lock.withPermit(
		Effect.gen(function* () {
			return yield* Match.value(yield* Ref.get(state)).pipe(
				Match.tag("Ready", () =>
					Effect.gen(function* () {
						if (bridge === undefined) return
						const current = bridge
						for (const arguments_ of partials)
							yield* sdk(() =>
								current.sendToolInputPartial({
									arguments: arguments_,
								}),
							)
						partials = []
						if (args !== undefined && !inputSent) {
							const arguments_ = args
							yield* sdk(() =>
								current.sendToolInput({
									arguments: arguments_,
								}),
							)
							inputSent = true
						}
						const completed = yield* Ref.get(result)
						if (completed !== undefined && inputSent && !resultSent) {
							yield* sdk(() => current.sendToolResult(completed))
							resultSent = true
						}
						if (cancellation !== undefined && !cancellationSent) {
							const reason = cancellation
							yield* sdk(() => current.sendToolCancelled({ reason }))
							cancellationSent = true
						}
					}),
				),
				Match.orElse(() => Effect.void),
			)
		}),
	)
	const invoke = async <A, E>(
		effect: Effect.Effect<A, E>,
		signal?: AbortSignal,
	): Promise<A> => {
		const currentScope = scope
		if (disposed || currentScope === undefined) throw new Error("UI is closed")
		const exit = await run(
			Effect.gen(function* () {
				const current = yield* Ref.get(state)
				yield* Match.value(current).pipe(
					Match.tag("Ready", () => Effect.void),
					Match.orElse(() =>
						Effect.fail(new HostActionDenied({ action: "UI is not ready" })),
					),
				)
				const fiber = yield* Effect.forkIn(effect, currentScope)
				const interrupt = Fiber.interrupt(fiber).pipe(Effect.asVoid)
				pendingActions = HashSet.add(pendingActions, interrupt)
				return yield* Fiber.join(fiber).pipe(
					Effect.onInterrupt(() => interrupt),
					Effect.ensuring(
						Effect.sync(
							() =>
								(pendingActions = HashSet.remove(pendingActions, interrupt)),
						),
					),
				)
			}),
			signal === undefined ? undefined : { signal },
		)
		return Match.value(exit).pipe(
			Match.tagsExhaustive({
				Failure: (exit) => {
					// Standard UI errors never include credential details or internal network failures.
					const error = Cause.findErrorOption(exit.cause)
					throw new Error(
						Match.value<Option.Option<unknown>>(error).pipe(
							Match.when(
								{ _tag: "Some", value: Match.instanceOf(HostActionDenied) },
								({ value }) => value.action,
							),
							Match.orElse(() => "Host rejected the UI request" as const),
						),
					)
				},
				Success: (exit) => ({ value: exit.value }),
			}),
		).value
	}
	const start = Effect.fn("Apps.load")(function* () {
		if (disposed)
			return yield* new Ui.UiError({
				reason: "Closed",
				issue: "UI has been closed",
			})
		if (scope !== undefined) yield* Scope.close(scope, Exit.void)
		const id = ++generation
		ready = Deferred.makeUnsafe<void, Ui.UiError>()
		inputSent = false
		resultSent = false
		cancellationSent = false
		yield* Ref.set(state, { _tag: "Loading" })
		let tool:
			| Effect.Success<ReturnType<UiClient["listTools"]>>["tools"][number]
			| undefined
		let cursor: string | undefined
		let seen = HashSet.empty<string>()
		do {
			const page = yield* options.client.listTools({
				source: "host",
				...(cursor === undefined ? {} : { cursor }),
			})
			tool = page.tools.find((entry) => entry.name === options.tool)
			cursor = page.nextCursor
			if (cursor !== undefined && HashSet.has(seen, cursor))
				return yield* new Ui.UiError({
					reason: "Protocol",
					issue: "The App repeated a tool cursor",
				})
			if (cursor !== undefined) seen = HashSet.add(seen, cursor)
		} while (tool === undefined && cursor !== undefined)
		if (tool === undefined)
			return yield* new Ui.UiError({
				reason: "Declaration",
				issue: "Tool is missing from the bound service",
			})
		const uri = yield* ui.toolResourceUri(tool)
		const read = yield* options.client.readResource({ uri }, { source: "host" })
		const resource = yield* Match.value(read).pipe(
			Match.tag("Completed", (read) => ui.readResource(uri, read.result)),
			Match.orElse(() =>
				Effect.fail(
					new Ui.UiError({
						reason: "Resource",
						issue: "UI resource needs more input",
					}),
				),
			),
		)
		const uiScope = yield* Scope.fork(parentScope)
		scope = uiScope
		yield* active.register({
			key: options.client.key,
			scope: uiScope,
		})
		const frame = document.createElement("iframe")
		frame.title = options.tool
		frame.referrerPolicy = "no-referrer"
		frame.srcdoc = resource.html
		yield* Ref.set(state, { _tag: "Initializing" })
		options.container.append(frame)
		const peer = frame.contentWindow
		if (peer === null)
			return yield* new Ui.UiError({
				reason: "Initialization",
				issue: "UI Window is unavailable",
			})
		const current = new AppBridge(
			null,
			options.hostInfo,
			{
				serverTools: {},
				serverResources: {},
				...(actions.message === undefined
					? {}
					: {
							message: actions.contentTypes ?? {
								text: {},
								image: {},
								audio: {},
								resource: {},
							},
						}),
				...(actions.openLink === undefined ? {} : { openLinks: {} }),
				...(actions.updateModelContext === undefined
					? {}
					: {
							updateModelContext: actions.contentTypes ?? {
								text: {},
								image: {},
								audio: {},
								resource: {},
							},
						}),
			},
			{ hostContext },
		)
		bridge = current
		const complete = <A>(operation: Client.OperationResult<A>) =>
			Match.value(operation).pipe(
				Match.tag("Completed", (operation) => Effect.succeed(operation.result)),
				Match.orElse(() =>
					Effect.fail(
						new HostActionDenied({
							action: "More input needs an explicit host action",
						}),
					),
				),
			)
		current.oncalltool = (params, extra) =>
			invoke(
				options.client
					.callTool(params, { source: "app" })
					.pipe(Effect.flatMap(complete)),
				extra.mcpReq.signal,
			)
		current.onreadresource = (params, extra) =>
			invoke(
				options.client
					.readResource(params, { source: "app" })
					.pipe(Effect.flatMap(complete)),
				extra.mcpReq.signal,
			)
		current.onlistresources = (params, extra) =>
			invoke(
				options.client.listResources(params?.cursor, "app"),
				extra.mcpReq.signal,
			)
		current.onlistresourcetemplates = (params, extra) =>
			invoke(
				options.client.listResourceTemplates(params?.cursor, "app"),
				extra.mcpReq.signal,
			)
		if (actions.message !== undefined) {
			const action = actions.message
			current.onmessage = (params, extra) =>
				invoke(action(source, params), extra.mcpReq.signal)
		}
		if (actions.openLink !== undefined) {
			const action = actions.openLink
			current.onopenlink = (params, extra) =>
				invoke(action(source, params), extra.mcpReq.signal)
		}
		if (actions.updateModelContext !== undefined) {
			const action = actions.updateModelContext
			current.onupdatemodelcontext = (params, extra) =>
				invoke(action(source, params).pipe(Effect.as({})), extra.mcpReq.signal)
		}
		if (actions.displayMode !== undefined) {
			const action = actions.displayMode
			current.onrequestdisplaymode = (params, extra) =>
				invoke(action(source, params), extra.mcpReq.signal)
		}
		if (actions.size !== undefined) {
			const action = actions.size
			current.onsizechange = (params) => {
				void invoke(action(source, params)).catch(() => {})
			}
		}
		current.onrequestteardown = () => {
			const error = new Ui.UiError({
				reason: "Closed",
				issue: "App requested teardown",
			})
			void error.pipe(fail, run)
		}
		current.oninitialized = () => {
			if (id !== generation || disposed) return
			void run(
				Effect.gen(function* () {
					return yield* Match.value(yield* Ref.get(state)).pipe(
						Match.tag("Initializing", () =>
							Effect.gen(function* () {
								yield* Ref.set(state, { _tag: "Ready" as const })
								yield* flush
								yield* Deferred.succeed(ready, undefined)
							}),
						),
						Match.orElse(() => Effect.void),
					)
				}).pipe(Effect.catchTag("UiError", fail)),
			)
		}
		const transport = new FrameTransport(peer, window.location.origin)
		let loaded = false
		const navigated = () => {
			if (loaded && id === generation) {
				const error = new Ui.UiError({
					reason: "Initialization",
					issue: "UI navigated away from its bound document",
				})
				void error.pipe(fail, run)
			}
			loaded = true
		}
		frame.addEventListener("load", navigated)
		yield* Scope.addFinalizer(
			uiScope,
			Effect.gen(function* () {
				yield* Match.value(yield* Ref.get(state)).pipe(
					Match.tag("Ready", () =>
						sdk(() => current.teardownResource({}, { timeout: 1000 })).pipe(
							Effect.ignore,
						),
					),
					Match.orElse(() => Effect.void),
				)
				yield* sdk(() => current.close()).pipe(Effect.ignore)
				frame.removeEventListener("load", navigated)
				frame.remove()
				if (id === generation)
					yield* Match.value(yield* Ref.get(state)).pipe(
						Match.not({ _tag: "Failed" }, () =>
							Ref.set(state, {
								_tag: "Closed",
							}),
						),
						Match.orElse(() => Effect.void),
					)
				yield* Deferred.fail(
					ready,
					new Ui.UiError({
						reason: "Closed",
						issue: "UI document was released",
					}),
				)
			}),
		)
		yield* sdk(() => current.connect(transport))
		yield* Effect.forkIn(
			Deferred.await(ready).pipe(
				Effect.timeoutOrElse({
					duration: options.timeoutMs ?? 10_000,
					orElse: () =>
						Effect.fail(
							new Ui.UiError({
								reason: "Initialization",
								issue: "UI did not finish initialization",
							}),
						),
				}),
				Effect.catchTag("UiError", (error) =>
					id === generation && error.reason !== "Closed"
						? fail(error)
						: Effect.void,
				),
			),
			parentScope,
		)
	})
	const load = start().pipe(
		Effect.catch((error) =>
			fail(
				Match.value(error).pipe(
					Match.tag("UiError", (error) => error),
					Match.orElse(
						() =>
							new Ui.UiError({
								reason: "Resource",
								issue: "Could not load UI from the bound service",
							}),
					),
				),
			),
		),
	)
	const close = Effect.gen(function* () {
		if (disposed) return
		disposed = true
		if (scope !== undefined) yield* Scope.close(scope, Exit.void)
		yield* Ref.set(state, { _tag: "Closed" })
		yield* Deferred.fail(
			ready,
			new Ui.UiError({
				reason: "Closed",
				issue: "UI has been closed",
			}),
		)
	})
	yield* Effect.addFinalizer(() => close)
	yield* load
	const session: Session = {
		state: Ref.get(state),
		ready: Effect.suspend(() => Deferred.await(ready)),
		result: Ref.get(result),
		close,
		inputPartial: (value) =>
			Effect.sync(() => {
				partials = EffectArray.append(partials, value)
			}).pipe(Effect.andThen(flush)),
		input: (value) =>
			Effect.sync(() => {
				args = value
			}).pipe(Effect.andThen(flush)),
		toolResult: (value) => Ref.set(result, value).pipe(Effect.andThen(flush)),
		cancel: (reason) =>
			Effect.sync(() => {
				cancellation = reason
			}).pipe(
				Effect.andThen(
					Effect.forEach(pendingActions, (interrupt) => interrupt, {
						discard: true,
						concurrency: "unbounded",
					}),
				),
				Effect.andThen(flush),
			),
		hostContext: (value) =>
			Effect.sync(() => {
				hostContext = value
				bridge?.setHostContext(value)
			}),
		reload: load.pipe(
			Effect.andThen(Effect.suspend(() => Deferred.await(ready))),
		),
	}
	return session
})
