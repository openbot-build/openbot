import type { Send } from "./DefaultAgent.ts"

/**
 * Makes an organization for the account when it has none, like a new person does.
 * OpenBot never makes one at sign-in. Answers the ID of the first organization.
 */
export const ensure = async (send: Send): Promise<string> => {
	const read = async (
		path: string,
		method: "GET" | "POST",
		payload?: unknown,
	) => {
		const response = await send(path, method, payload)
		const body = await response.text()
		if (!response.ok) throw new Error(response.status + " " + body)
		return JSON.parse(body) as Record<string, unknown>
	}
	const listed = await read("/v1/organizations", "GET")
	const [first] = listed["items"] as ReadonlyArray<{ readonly id: string }>
	if (first !== undefined) return first.id
	const created = await read("/v1/organizations", "POST", { name: "Test" })
	return created["id"] as string
}
