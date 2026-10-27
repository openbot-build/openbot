// Checks the running images from inside the Compose network.
// compose.check.yaml starts this script after OpenBot and Protocol Test are healthy.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const request = (url, init = {}) =>
	fetch(url, { ...init, signal: AbortSignal.timeout(5000) })

const secret = (
	await readFile("/run/secrets/OPENBOT_CLUSTER_SECRET", "utf8")
).trim()
// The same file runs in each server to check the other node over the private network.
const servers = process.argv.slice(2)
for (const openbot of servers.length > 0
	? servers
	: ["http://openbot:3000", "http://openbot-peer:3000"]) {
	const anonymous = await request(`${openbot}/v1/chats`)
	assert.equal(anonymous.status, 401, "The API does not require authentication")

	const keyed = await request(`${openbot}/v1/chats`, {
		headers: { authorization: "Bearer ob_invalid" },
	})
	assert.equal(keyed.status, 401, "The API does not reject invalid API keys")

	const schema = await request(`${openbot}/openapi.json`)
	assert.equal(schema.status, 200, "The OpenAPI document is not available")
	assert.ok(
		(await schema.json()).openapi,
		"The OpenAPI document has no version",
	)

	for (const path of ["/internal/executions/rpc", "/internal/resources/rpc"]) {
		for (const authorization of [undefined, "Bearer wrong-cluster-secret"]) {
			const response = await request(`${openbot}${path}`, {
				method: "POST",
				headers: authorization === undefined ? {} : { authorization },
			})
			assert.equal(response.status, 401, "Private RPC accepted a wrong secret")
		}
	}
	// Use the runner's Ping method. A health response alone does not test private RPC.
	const ping = await request(`${openbot}/internal/executions/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${secret}`,
			"content-type": "application/x-ndjson",
		},
		body:
			JSON.stringify({
				_tag: "Request",
				id: "1",
				tag: "Ping",
				payload: null,
				headers: [],
			}) + "\n",
	})
	assert.equal(ping.status, 200, "Private runner RPC is not available")
	const replies = (await ping.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
	assert.ok(
		replies.some(
			(reply) =>
				reply._tag === "Exit" &&
				reply.requestId === "1" &&
				reply.exit?._tag === "Success",
		),
		"Private runner Ping failed",
	)
}

const protocolTest = "http://protocol-test:3001"
const publicOrigin = "https://protocol-test.example.com"

const catalog = await request(`${protocolTest}/.well-known/ai-catalog.json`)
assert.equal(catalog.status, 200, "The Protocol Test Catalog is not available")
const document = await catalog.json()
assert.equal(document.host.identifier, publicOrigin)
assert.ok(
	document.entries.some(
		(entry) => entry.url === `${publicOrigin}/apps/anonymous/server-card.json`,
	),
	"The Catalog does not list the anonymous app",
)

const protocolVersion = "2026-07-28"
const discovery = await request(`${protocolTest}/mcp/anonymous`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": protocolVersion,
		"mcp-method": "server/discover",
	},
	body: JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "server/discover",
		params: {
			_meta: {
				"io.modelcontextprotocol/protocolVersion": protocolVersion,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": {
					name: "check-host",
					version: "1.0.0",
				},
			},
		},
	}),
})
assert.equal(discovery.status, 200, "Protocol Test MCP discovery failed")
const message = await discovery.json()
assert.equal(message.error, undefined, "Protocol Test MCP discovery failed")
assert.equal(
	message.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name,
	"openbot.protocol-test/anonymous",
)

console.log("All image checks passed.")
