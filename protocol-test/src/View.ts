import { App } from "@modelcontextprotocol/ext-apps"
import {
	Crypto,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	PlatformError,
	Schema,
} from "effect"

const app = new App({ name: "Protocol Test workspace", version: "0.1.0" }, {})
/** The page build in `tsdown.config.ts` writes each element, so a missing one is a broken build. */
const element = <T extends Element>(
	selector: string,
	type: { new (...args: never[]): T },
): Effect.Effect<T> =>
	Effect.suspend(() => {
		const found = document.querySelector(selector)
		return found instanceof type
			? Effect.succeed(found)
			: Effect.die(new Error("Missing App element: " + selector))
	})
const Output = Schema.Struct({
	workspace: Schema.String,
	revision: Schema.Int,
	notes: Schema.Array(
		Schema.Struct({ id: Schema.String, text: Schema.String }),
	),
})

// No Effect platform package runs in the browser here, so this runtime makes
// the Crypto service from the Web Crypto API of the browser.
const runtime = ManagedRuntime.make(
	Layer.succeed(
		Crypto.Crypto,
		Crypto.make({
			randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
			digest: (algorithm, data) =>
				Effect.tryPromise({
					try: () => crypto.subtle.digest(algorithm, new Uint8Array(data)),
					catch: (cause) =>
						PlatformError.systemError({
							_tag: "Unknown",
							module: "Crypto",
							method: "digest",
							description: "Could not compute digest",
							cause,
						}),
				}).pipe(Effect.map((digest) => new Uint8Array(digest))),
		}),
	),
)

class HostRequestFailed extends Schema.TaggedError<
	HostRequestFailed,
	{ readonly brand: unique symbol }
>()("HostRequestFailed", { message: Schema.String, cause: Schema.Defect() }) {}

const request = <A>(
	evaluate: () => Promise<A>,
	fallback = "The host request failed.",
) =>
	Effect.tryPromise({
		try: evaluate,
		catch: (cause) =>
			HostRequestFailed.make({
				message: cause instanceof Error ? cause.message : fallback,
				cause,
			}),
	})

const main = Effect.gen(function* () {
	const page = yield* Effect.all({
		output: element("#output", HTMLPreElement),
		status: element("#status", HTMLParagraphElement),
		workspace: element("#workspace", HTMLInputElement),
		note: element("#note", HTMLTextAreaElement),
		controls: element("#controls", HTMLFieldSetElement),
		host: element("#host", HTMLPreElement),
		read: element("#read", HTMLButtonElement),
		write: element("#write", HTMLFormElement),
		resource: element("#resource", HTMLButtonElement),
		context: element("#context", HTMLButtonElement),
		message: element("#message", HTMLButtonElement),
		link: element("#link", HTMLButtonElement),
		documentation: element("#documentation", HTMLAnchorElement),
		fullscreen: element("#fullscreen", HTMLButtonElement),
		inline: element("#inline", HTMLButtonElement),
		resize: element("#resize", HTMLButtonElement),
	})
	const { output, status, workspace, note, controls, host } = page
	let current = Option.none<typeof Output.Type>()
	let disposed = false
	const display = (value: unknown) => {
		output.textContent = JSON.stringify(value, null, 2)
		const decoded = Schema.decodeUnknownOption(Output)(value)
		if (Option.isSome(decoded)) {
			current = decoded
			workspace.value = decoded.value.workspace
		}
	}
	app.ontoolinput = (input) => {
		if (typeof input.arguments?.["workspace"] === "string")
			workspace.value = input.arguments["workspace"]
	}
	app.ontoolresult = (value) => {
		display(value.structuredContent ?? value)
		status.textContent =
			value.isError === true
				? "The tool returned an error."
				: "Existing tool result loaded."
	}
	app.ontoolcancelled = () => {
		status.textContent = "The tool was cancelled."
	}
	app.onhostcontextchanged = (context) => {
		host.textContent = JSON.stringify(context, null, 2)
		if (context.theme !== undefined)
			document.documentElement.style.colorScheme = context.theme
	}
	app.onteardown = () => {
		disposed = true
		controls.disabled = true
		status.textContent = "App released."
		return {}
	}

	const run = Effect.fn("View.run")(function* <R>(
		action: Effect.Effect<unknown, HostRequestFailed, R>,
	) {
		if (disposed) return
		controls.disabled = true
		status.textContent = "Waiting for the host."
		yield* action.pipe(
			Effect.matchEffect({
				onFailure: (error) =>
					Effect.logWarning("The host request failed.", error.cause).pipe(
						Effect.andThen(
							Effect.sync(() => {
								if (!disposed) status.textContent = error.message
							}),
						),
					),
				onSuccess: (value) =>
					Effect.sync(() => {
						if (disposed) return
						display(value)
						status.textContent = "Host request completed."
					}),
			}),
			// This also catches a throw in display. The forked fiber has no
			// observer, so a defect that is not caught here is lost.
			Effect.catchDefect((defect) =>
				Effect.logError("The App action failed.", defect).pipe(
					Effect.andThen(
						Effect.sync(() => {
							if (!disposed)
								status.textContent = "The App action failed. See the console."
						}),
					),
				),
			),
			Effect.ensuring(
				Effect.sync(() => {
					if (!disposed) controls.disabled = false
				}),
			),
		)
	})
	const start = (
		action: Effect.Effect<unknown, HostRequestFailed, Crypto.Crypto>,
	) => {
		runtime.runFork(run(action))
	}
	page.read.addEventListener("click", () =>
		start(
			Effect.gen(function* () {
				const value = yield* request(() =>
					app.callServerTool({
						name: "ui_read_workspace",
						arguments: { workspace: workspace.value },
					}),
				)
				if (value.structuredContent !== undefined)
					display(value.structuredContent)
				return value.structuredContent ?? value
			}),
		),
	)
	page.write.addEventListener("submit", (event) => {
		event.preventDefault()
		start(
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const idempotencyKey = yield* Effect.orDie(crypto.randomUUIDv4())
				const value = yield* request(() =>
					app.callServerTool({
						name: "write_note",
						arguments: {
							workspace: workspace.value,
							text: note.value,
							idempotencyKey,
						},
					}),
				)
				return value.structuredContent ?? value
			}),
		)
	})
	page.resource.addEventListener("click", () =>
		start(
			request(() =>
				app.readServerResource({
					uri: "protocol-test://workspace/" + workspace.value,
				}),
			),
		),
	)
	page.context.addEventListener("click", () =>
		start(
			request(() =>
				app.updateModelContext({
					content: [
						{
							type: "text",
							text:
								"Selected test workspace: " +
								workspace.value +
								". Current data: " +
								JSON.stringify(Option.getOrElse(current, () => ({}))),
						},
					],
				}),
			),
		),
	)
	page.message.addEventListener("click", () =>
		start(
			request(() =>
				app.sendMessage({
					role: "user",
					content: [
						{
							type: "text",
							text:
								"Summarize the Protocol Test workspace " +
								workspace.value +
								".",
						},
					],
				}),
			),
		),
	)
	page.link.addEventListener("click", () =>
		start(request(() => app.openLink({ url: page.documentation.href }))),
	)
	page.fullscreen.addEventListener("click", () =>
		start(request(() => app.requestDisplayMode({ mode: "fullscreen" }))),
	)
	page.inline.addEventListener("click", () =>
		start(request(() => app.requestDisplayMode({ mode: "inline" }))),
	)
	page.resize.addEventListener("click", () =>
		start(
			request(() =>
				app.sendSizeChanged({ height: document.body.scrollHeight }),
			),
		),
	)

	controls.disabled = true
	yield* request(
		() => app.connect(),
		"The App could not connect to its host.",
	).pipe(
		Effect.matchEffect({
			onFailure: (error) =>
				Effect.logError(
					"The App could not connect to its host.",
					error.cause,
				).pipe(
					Effect.andThen(
						Effect.sync(() => {
							status.textContent = error.message
						}),
					),
				),
			onSuccess: () =>
				Effect.sync(() => {
					controls.disabled = false
					status.textContent =
						"Connected. Waiting for an existing result or for you to choose an action."
				}),
		}),
	)
})

runtime.runFork(
	main.pipe(
		Effect.tapDefect((defect) =>
			Effect.logError("The App page could not start.", defect),
		),
	),
)
