// The tests give each program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { afterAll, assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Config from "../src/Config.ts"
import * as Pair from "../src/Pair.ts"

const folder = mkdtempSync(join(tmpdir(), "openbot-computer-pair-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

type Handler = (
	request: IncomingMessage,
	body: any,
	response: ServerResponse,
) => void

/**
 * A fake OpenBot. It calls the handler with each request and its JSON body.
 * It stops when the test's scope closes.
 */
const fakeOpenBot = (handler: Handler) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			const server = createServer((request, response) => {
				let text = ""
				request.on("data", (chunk) => (text += chunk))
				request.on("end", () =>
					handler(
						request,
						text === "" ? undefined : JSON.parse(text),
						response,
					),
				)
			})
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			)
			const { port } = server.address() as AddressInfo
			return { server, url: `http://127.0.0.1:${port}` }
		}),
		({ server }) =>
			Effect.promise(
				() =>
					new Promise<void>((resolve) => {
						server.close(() => resolve())
						// fetch keeps connections open for reuse. Close them, so the server stops at once.
						server.closeAllConnections()
					}),
			),
	)

const json = (response: ServerResponse, status: number, body: unknown) => {
	response.writeHead(status, { "content-type": "application/json" })
	response.end(JSON.stringify(body))
}

const pair = (url: string, file: string) => {
	const shown: Array<string> = []
	return Pair.pair({
		url,
		file,
		output: {
			showCode: (pairing, approveUrl) =>
				Effect.sync(() => shown.push(pairing.code, approveUrl)),
		},
	}).pipe(
		Effect.map((result) => ({ ...result, shown })),
		Effect.provide(Layer.merge(FetchHttpClient.layer, NodeFileSystem.layer)),
	)
}

it.live("pair shows the code, polls until approval, and saves the token", () =>
	Effect.gen(function* () {
		const starts: Array<any> = []
		let polls = 0
		const openbot = yield* fakeOpenBot((request, body, response) => {
			if (
				request.method === "POST" &&
				request.url === "/v1/hooks/computers/pairings"
			) {
				starts.push(body)
				return json(response, 201, {
					id: "pairing-1",
					code: "KDTW-7Q3M",
					secret: "pairing-secret",
					interval: 1,
					expiresAt: Date.now() + 60_000,
				})
			}
			if (
				request.method === "POST" &&
				request.url === "/v1/hooks/computers/pairings/pairing-1/poll"
			) {
				assert.strictEqual(
					request.headers.authorization,
					"Bearer pairing-secret",
				)
				polls += 1
				return json(
					response,
					200,
					polls < 2
						? { _tag: "Pending" }
						: {
								_tag: "Approved",
								computer: "computer-1",
								token: `token-${starts.length}`,
							},
				)
			}
			json(response, 404, {})
		})
		const file = join(folder, "computer.json")
		const first = yield* pair(openbot.url, file)
		assert.strictEqual(first.computer, "computer-1")
		assert.deepStrictEqual(first.shown, [
			"KDTW-7Q3M",
			`${openbot.url}/v1/computer-pairings/KDTW-7Q3M/approve`,
		])
		assert.strictEqual(polls, 2)
		const start = starts[0]
		assert.strictEqual(start.desktop, false)
		assert.strictEqual(start.os, process.platform)
		assert.strictEqual(start.arch, process.arch)
		assert.strictEqual(typeof start.hostname, "string")
		assert.strictEqual(typeof start.version, "string")
		assert.ok(start.machineId.length >= 16)
		assert.deepStrictEqual(first.config, {
			url: openbot.url,
			token: "token-1",
			machineId: start.machineId,
		})
		assert.strictEqual(statSync(file).mode & 0o777, 0o600)

		// A second pairing keeps the machine ID and saves the new token.
		polls = 0
		const second = yield* pair(`${openbot.url}/`, file)
		assert.strictEqual(starts[1].machineId, start.machineId)
		assert.strictEqual(second.config.token, "token-2")
		const saved = yield* Config.read(file).pipe(
			Effect.provide(NodeFileSystem.layer),
		)
		assert.strictEqual(
			saved._tag === "Some" ? saved.value.token : undefined,
			"token-2",
		)
	}),
)

it.live("pair stops with a clear message when OpenBot ends the pairing", () =>
	Effect.gen(function* () {
		const openbot = yield* fakeOpenBot((request, _body, response) => {
			if (request.url === "/v1/hooks/computers/pairings")
				return json(response, 201, {
					id: "pairing-2",
					code: "AAAA-BBBB",
					secret: "s",
					interval: 1,
					expiresAt: Date.now() + 60_000,
				})
			json(response, 404, { _tag: "PairingInvalid" })
		})
		const file = join(folder, "denied.json")
		const error = yield* Effect.flip(pair(openbot.url, file))
		assert.match(String(error), /OpenBot ended this pairing/)
		assert.throws(() => statSync(file))
	}),
)

it.live("pair stops when the code expires", () =>
	Effect.gen(function* () {
		const openbot = yield* fakeOpenBot((request, _body, response) => {
			if (request.url === "/v1/hooks/computers/pairings")
				return json(response, 201, {
					id: "pairing-3",
					code: "CCCC-DDDD",
					secret: "s",
					interval: 1,
					expiresAt: Date.now() + 500,
				})
			json(response, 200, { _tag: "Pending" })
		})
		const error = yield* Effect.flip(
			pair(openbot.url, join(folder, "expired.json")),
		)
		assert.match(String(error), /Nobody approved the code in time/)
	}),
)
