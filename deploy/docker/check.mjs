// Checks the running images from inside the Compose network.
// compose.check.yaml starts this script after OpenBot and Protocol Test are healthy.
import assert from "node:assert/strict"

const request = (url, init = {}) =>
	fetch(url, { ...init, signal: AbortSignal.timeout(5000) })

const openbot = "http://openbot:3000"

const anonymous = await request(`${openbot}/v1/chats`)
assert.equal(anonymous.status, 401, "The API does not require authentication")

const keyed = await request(`${openbot}/v1/chats`, {
	headers: { authorization: "Bearer ob_invalid" },
})
assert.equal(keyed.status, 401, "The API does not reject invalid API keys")

const schema = await request(`${openbot}/openapi.json`)
assert.equal(schema.status, 200, "The OpenAPI document is not available")
assert.ok((await schema.json()).openapi, "The OpenAPI document has no version")

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
