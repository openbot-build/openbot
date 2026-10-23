/** Sends one request with the credential of a person. */
export type Send = (
	path: string,
	method: "GET" | "POST" | "PATCH",
	payload?: unknown,
) => Promise<Response>

/**
 * Makes a Bot and sets it as the default Bot of the person, when they have none.
 * Answers the ID of the default Bot.
 */
export const ensure = async (send: Send): Promise<string> => {
	const read = async (
		path: string,
		method: "GET" | "POST" | "PATCH",
		payload?: unknown,
	) => {
		const response = await send(path, method, payload)
		const body = await response.text()
		if (!response.ok) throw new Error(response.status + " " + body)
		return JSON.parse(body) as Record<string, unknown>
	}
	const settings = await read("/v1/me/settings", "GET")
	if (typeof settings["defaultBot"] === "string") return settings["defaultBot"]
	const bot = await read("/v1/bots", "POST", {
		name: "Assistant",
		role: "Helps one person",
		instructions: "Help the person.",
	})
	await read("/v1/me/settings", "PATCH", {
		expectedVersion: settings["version"],
		defaultBot: bot["id"],
	})
	return bot["id"] as string
}
