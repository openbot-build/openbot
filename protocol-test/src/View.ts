import { App } from "@modelcontextprotocol/ext-apps"
import { Option, Schema } from "effect"

const app = new App({ name: "Protocol Test workspace", version: "0.1.0" }, {})
const element = <T extends Element>(
	selector: string,
	type: { new (...args: never[]): T },
): T => {
	const found = document.querySelector(selector)
	if (!(found instanceof type))
		throw new Error("Missing App element: " + selector)
	return found
}
const output = element("#output", HTMLPreElement)
const status = element("#status", HTMLParagraphElement)
const workspace = element("#workspace", HTMLInputElement)
const note = element("#note", HTMLTextAreaElement)
const controls = element("#controls", HTMLFieldSetElement)
const host = element("#host", HTMLPreElement)
const Output = Schema.Struct({
	workspace: Schema.String,
	revision: Schema.Int,
	notes: Schema.Array(
		Schema.Struct({ id: Schema.String, text: Schema.String }),
	),
})
let current: typeof Output.Type | undefined
let disposed = false
const display = (value: unknown) => {
	output.textContent = JSON.stringify(value, null, 2)
	const decoded = Option.getOrUndefined(
		Schema.decodeUnknownOption(Output)(value),
	)
	if (decoded !== undefined) {
		current = decoded
		workspace.value = decoded.workspace
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
app.onteardown = async () => {
	disposed = true
	controls.disabled = true
	status.textContent = "App released."
	return {}
}

const run = async (action: () => Promise<unknown>) => {
	if (disposed) return
	controls.disabled = true
	status.textContent = "Waiting for the host."
	try {
		const value = await action()
		if (!disposed) {
			display(value)
			status.textContent = "Host request completed."
		}
	} catch (error) {
		if (!disposed)
			status.textContent =
				error instanceof Error ? error.message : "The host request failed."
	} finally {
		if (!disposed) controls.disabled = false
	}
}
element("#read", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(async () => {
			const value = await app.callServerTool({
				name: "ui_read_workspace",
				arguments: { workspace: workspace.value },
			})
			if (value.structuredContent !== undefined)
				display(value.structuredContent)
			return value.structuredContent ?? value
		}),
)
element("#write", HTMLFormElement).addEventListener("submit", (event) => {
	event.preventDefault()
	const idempotencyKey = crypto.randomUUID()
	void run(async () => {
		const value = await app.callServerTool({
			name: "write_note",
			arguments: {
				workspace: workspace.value,
				text: note.value,
				idempotencyKey,
			},
		})
		return value.structuredContent ?? value
	})
})
element("#resource", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(() =>
			app.readServerResource({
				uri: "protocol-test://workspace/" + workspace.value,
			}),
		),
)
element("#context", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(() =>
			app.updateModelContext({
				content: [
					{
						type: "text",
						text:
							"Selected test workspace: " +
							workspace.value +
							". Current data: " +
							JSON.stringify(current ?? {}),
					},
				],
			}),
		),
)
element("#message", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(() =>
			app.sendMessage({
				role: "user",
				content: [
					{
						type: "text",
						text:
							"Summarize the Protocol Test workspace " + workspace.value + ".",
					},
				],
			}),
		),
)
element("#link", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(() =>
			app.openLink({ url: element("#documentation", HTMLAnchorElement).href }),
		),
)
element("#fullscreen", HTMLButtonElement).addEventListener(
	"click",
	() => void run(() => app.requestDisplayMode({ mode: "fullscreen" })),
)
element("#inline", HTMLButtonElement).addEventListener(
	"click",
	() => void run(() => app.requestDisplayMode({ mode: "inline" })),
)
element("#resize", HTMLButtonElement).addEventListener(
	"click",
	() =>
		void run(() => app.sendSizeChanged({ height: document.body.scrollHeight })),
)

controls.disabled = true
try {
	await app.connect()
	controls.disabled = false
	status.textContent =
		"Connected. Waiting for an existing result or for you to choose an action."
} catch (error) {
	status.textContent =
		error instanceof Error
			? error.message
			: "The App could not connect to its host."
}
