import {
	Array as Arr,
	HashSet,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Ref,
	Schema,
	Scope,
	Semaphore,
	Match,
	Option,
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

const allContentTypes = {
	text: {},
	image: {},
	audio: {},
	resource: {},
}

/** The error reply that the SDK sends to the App. Its message is safe to show. */
class UiRequestRejected extends Schema.TaggedError<
	UiRequestRejected,
	{ readonly brand: unique symbol }
>()("UiRequestRejected", {
	message: Schema.String,
}) {}

const sdk = <A>(call: () => Promise<A>) =>
	Effect.tryPromise({
		try: call,
		catch: (cause) =>
			Ui.UiError.make({
				reason: "Protocol",
				issue: "Apps bridge operation failed",
				cause,
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
	// The SDK callbacks start their fibers in this set, so closing the mount scope stops them.
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)<never>()
	const runPromise = yield* FiberSet.runtimePromise(callbacks)<never>()
	const source: Source = { key: options.client.key, tool: options.tool }
	const state = yield* Ref.make<State>({ _tag: "Loading" })
	const result = yield* Ref.make(Option.fromUndefinedOr(options.result))
	const partials = yield* Ref.make<ReadonlyArray<Schema.JsonObject>>([])
	const lock = yield* Semaphore.make(1)
	const loading = yield* Semaphore.make(1)
	let scope: Scope.Closeable | undefined
	// The UI requests of the current document. Closing its UI scope stops them.
	let requests: FiberSet.FiberSet | undefined
	let bridge: AppBridge | undefined
	let ready = yield* Deferred.make<void, Ui.UiError>()
	let args = options.arguments
	let cancellation = Option.none<string>()
	let inputSent = false
	let resultSent = false
	let cancellationSent = false
	let generation = 0
	let disposed = false
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
						for (const arguments_ of yield* Ref.getAndSet(partials, []))
							yield* sdk(() =>
								current.sendToolInputPartial({
									arguments: arguments_,
								}),
							)
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
						if (Option.isSome(completed) && inputSent && !resultSent) {
							yield* sdk(() => current.sendToolResult(completed.value))
							resultSent = true
						}
						if (Option.isSome(cancellation) && !cancellationSent) {
							const reason = cancellation.value
							yield* sdk(() => current.sendToolCancelled({ reason }))
							cancellationSent = true
						}
					}),
				),
				Match.orElse(() => Effect.void),
			)
		}),
	)
	// AppBridge handlers must return a Promise. A rejected Promise is how the SDK
	// sends an error reply to the App, with the message of the error.
	const invoke = <A, E>(
		effect: Effect.Effect<A, E>,
		signal?: AbortSignal,
	): Promise<A> =>
		runPromise(
			Effect.gen(function* () {
				const current = requests
				if (disposed || current === undefined)
					return yield* HostActionDenied.make({ action: "UI is closed" })
				yield* Match.value(yield* Ref.get(state)).pipe(
					Match.tag("Ready", () => Effect.void),
					Match.orElse(() =>
						Effect.fail(HostActionDenied.make({ action: "UI is not ready" })),
					),
				)
				const fiber = yield* FiberSet.run(current, effect)
				return yield* Fiber.join(fiber).pipe(
					Effect.onInterrupt(() => Fiber.interrupt(fiber)),
				)
			}).pipe(
				Effect.tapCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logDebug("The UI request failed", cause),
				),
				// Standard UI errors never include credential details or internal network failures.
				// An action that the host stops gets the same reply.
				Effect.catchCause((cause) =>
					Effect.fail(
						UiRequestRejected.make({
							message: Cause.findErrorOption(cause).pipe(
								Option.filter(Schema.is(HostActionDenied)),
								Option.match({
									onNone: () => "Host rejected the UI request",
									onSome: (denied) => denied.action,
								}),
							),
						}),
					),
				),
			),
			signal === undefined ? undefined : { signal },
		)
	const start = Effect.fn("Apps.load")(function* () {
		if (disposed)
			return yield* Ui.UiError.make({
				reason: "Closed",
				issue: "UI has been closed",
			})
		if (scope !== undefined) yield* Scope.close(scope, Exit.void)
		const id = ++generation
		const initialized = yield* Deferred.make<void, Ui.UiError>()
		ready = initialized
		// A flush for the old document can still be running. It holds the lock, so it
		// cannot mark the input as sent after this reset.
		yield* lock.withPermit(
			Effect.gen(function* () {
				inputSent = false
				resultSent = false
				cancellationSent = false
				yield* Ref.set(state, { _tag: "Loading" })
			}),
		)
		let tool =
			Option.none<
				Effect.Success<ReturnType<UiClient["listTools"]>>["tools"][number]
			>()
		let cursor: string | undefined
		let seen = HashSet.empty<string>()
		do {
			const page = yield* options.client.listTools({
				source: "host",
				...(cursor === undefined ? {} : { cursor }),
			})
			tool = Arr.findFirst(page.tools, (entry) => entry.name === options.tool)
			cursor = page.nextCursor
			if (cursor !== undefined && HashSet.has(seen, cursor))
				return yield* Ui.UiError.make({
					reason: "Protocol",
					issue: "The App repeated a tool cursor",
				})
			if (cursor !== undefined) seen = HashSet.add(seen, cursor)
		} while (Option.isNone(tool) && cursor !== undefined)
		if (Option.isNone(tool))
			return yield* Ui.UiError.make({
				reason: "Declaration",
				issue: "Tool is missing from the bound service",
			})
		const uri = yield* ui.toolResourceUri(tool.value)
		const read = yield* options.client.readResource({ uri }, { source: "host" })
		const resource = yield* Match.value(read).pipe(
			Match.tag("Completed", (read) => ui.readResource(uri, read.result)),
			Match.orElse(() =>
				Effect.fail(
					Ui.UiError.make({
						reason: "Resource",
						issue: "UI resource needs more input",
					}),
				),
			),
		)
		// The UI can close while the service answers. Then no new document starts.
		if (disposed)
			return yield* Ui.UiError.make({
				reason: "Closed",
				issue: "UI has been closed",
			})
		const uiScope = yield* Scope.fork(parentScope)
		scope = uiScope
		requests = yield* FiberSet.make().pipe(Scope.provide(uiScope))
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
			return yield* Ui.UiError.make({
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
							message: actions.contentTypes ?? allContentTypes,
						}),
				...(actions.openLink === undefined ? {} : { openLinks: {} }),
				...(actions.updateModelContext === undefined
					? {}
					: {
							updateModelContext: actions.contentTypes ?? allContentTypes,
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
						HostActionDenied.make({
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
				// A size change is a notification. It has no reply, so a denied action has no one to tell.
				void invoke(action(source, params)).catch(() => undefined)
			}
		}
		current.onrequestteardown = () => {
			const error = Ui.UiError.make({
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
								yield* Deferred.succeed(initialized, undefined)
							}),
						),
						Match.orElse(() => Effect.void),
					)
				}).pipe(
					// A flush for a released document must not fail the next one.
					Effect.catchTag("UiError", (error) =>
						id === generation ? fail(error) : Effect.void,
					),
				),
			)
		}
		const transport = new FrameTransport(peer, window.location.origin)
		let loaded = false
		const navigated = () => {
			if (loaded && id === generation) {
				const error = Ui.UiError.make({
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
				// Teardown is best effort. The frame is removed below even when the App does not answer.
				yield* Match.value(yield* Ref.get(state)).pipe(
					Match.tag("Ready", () =>
						sdk(() => current.teardownResource({}, { timeout: 1000 })).pipe(
							Effect.ignore({ log: "Debug" }),
						),
					),
					Match.orElse(() => Effect.void),
				)
				yield* sdk(() => current.close()).pipe(Effect.ignore({ log: "Debug" }))
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
					initialized,
					Ui.UiError.make({
						reason: "Closed",
						issue: "UI document was released",
					}),
				)
			}),
		)
		yield* sdk(() => current.connect(transport))
		yield* Effect.forkIn(
			Deferred.await(initialized).pipe(
				Effect.timeoutOrElse({
					duration: options.timeoutMs ?? 10_000,
					orElse: () =>
						Effect.fail(
							Ui.UiError.make({
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
	// One load runs at a time, so a reload cannot leave an old document open.
	const load = loading.withPermit(
		start().pipe(
			Effect.catch((error) =>
				fail(
					Match.value(error).pipe(
						Match.tag("UiError", (error) => error),
						Match.orElse((cause) =>
							Ui.UiError.make({
								reason: "Resource",
								issue: "Could not load UI from the bound service",
								cause,
							}),
						),
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
			Ui.UiError.make({
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
			Ref.update(partials, Arr.append(value)).pipe(Effect.andThen(flush)),
		input: (value) =>
			Effect.sync(() => {
				args = value
			}).pipe(Effect.andThen(flush)),
		toolResult: (value) =>
			Ref.set(result, Option.some(value)).pipe(Effect.andThen(flush)),
		cancel: (reason) =>
			Effect.sync(() => {
				cancellation = Option.some(reason)
			}).pipe(
				Effect.andThen(
					Effect.suspend(() =>
						requests === undefined ? Effect.void : FiberSet.clear(requests),
					),
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
