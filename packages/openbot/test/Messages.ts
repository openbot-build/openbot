import { ChatView, MessageReceipt } from "@openbot-build/api"
import { Schema } from "effect"

/** Sends one request with the credential of a person. */
export type Send = (
	path: string,
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	payload?: unknown,
) => Promise<Response>

const json = async (response: Response) => {
	const body = await response.text()
	if (!response.ok) throw new Error(response.status + " " + body)
	return JSON.parse(body) as unknown
}

/** A simulated model of the development platform. */
export const model = (name: string) => ({
	_tag: "Config.Selection",
	provider: "development",
	model: name,
})

/** Makes a Bot of the caller and answers its ID. */
export const bot = async (
	send: Send,
	input: {
		readonly name?: string
		readonly model?: ReturnType<typeof model>
		readonly instructions?: string
	} = {},
): Promise<string> => {
	const created = (await json(
		await send("/v1/bots", "POST", {
			name: input.name ?? "Helper",
			role: "Helps in tests",
			instructions: input.instructions ?? "Help the person.",
			...(input.model === undefined ? {} : { model: input.model }),
		}),
	)) as { readonly id: string }
	return created.id
}

/** Sends a message to the direct Chat of the caller with a Bot. */
export const message = async (
	send: Send,
	bot: string,
	input: string,
): Promise<MessageReceipt> => {
	const response = await send(`/v1/bots/${bot}/messages`, "POST", { input })
	if (response.status !== 202)
		throw new Error(response.status + " " + (await response.text()))
	return Schema.decodeUnknownSync(MessageReceipt)(await response.json())
}

/** Sends a message to a Chat. */
export const send = async (
	request: Send,
	chat: string,
	input: string,
): Promise<MessageReceipt> => {
	const response = await request(`/v1/chats/${chat}/messages`, "POST", {
		input,
	})
	if (response.status !== 202)
		throw new Error(response.status + " " + (await response.text()))
	return Schema.decodeUnknownSync(MessageReceipt)(await response.json())
}

/** Reads the view of a Chat. */
export const view = async (send: Send, chat: string): Promise<ChatView> =>
	Schema.decodeUnknownSync(ChatView)(
		await json(await send(`/v1/chats/${chat}`, "GET")),
	)

/**
 * Waits until no Turn runs in a Chat and no input waits in its inbox.
 * It fails after about thirty seconds.
 */
export const settled = async (send: Send, chat: string): Promise<ChatView> => {
	let current = await view(send, chat)
	for (let index = 0; index < 60; index++) {
		if (
			current.activity !== "active" &&
			current.status !== "Running" &&
			current.inbox === 0
		)
			return current
		current = Schema.decodeUnknownSync(ChatView)(
			await json(
				await send(
					`/v1/chats/${chat}/wait?` +
						new URLSearchParams({
							after: String(current.chat.revision),
							afterActivity: current.activity,
							timeoutMs: "500",
						}),
					"GET",
				),
			),
		)
	}
	throw new Error(`The Chat ${chat} did not come to rest in time`)
}

/** Sends a message to a Bot and waits until its Chat comes to rest. */
export const talk = async (
	send: Send,
	bot: string,
	input: string,
): Promise<{ readonly receipt: MessageReceipt; readonly view: ChatView }> => {
	const receipt = await message(send, bot, input)
	return { receipt, view: await settled(send, receipt.chat) }
}
