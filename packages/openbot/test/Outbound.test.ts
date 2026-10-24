// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off
import { assert, expect, it } from "@effect/vitest"
import { createServer, type RequestListener } from "node:http"
import {
	ConfigProvider,
	Effect,
	HashSet,
	Layer,
	ManagedRuntime,
	Result,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { fetch as undiciFetch, getGlobalDispatcher } from "undici"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import * as OutboundGuard from "../src/network/OutboundGuard.ts"
import * as OutboundPolicy from "../src/network/OutboundPolicy.ts"

const startHttp = async (handler: RequestListener) => {
	let requests = 0
	const server = createServer((req, res) => {
		requests++
		handler(req, res)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (address === null || typeof address === "string")
		throw new Error("Expected a TCP address")
	return {
		port: address.port,
		requests: () => requests,
		[Symbol.asyncDispose]: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

const parse = (input: string) => {
	const result = OutboundPolicy.parse(input)
	if (Result.isFailure(result)) throw new Error(result.failure)
	return result.success
}

const readPolicy = Effect.service(OutboundPolicy.OutboundPolicy)

const isBlocked = (error: unknown) =>
	error instanceof TypeError &&
	error.cause instanceof OutboundGuard.OutboundBlocked

it("the allow list takes IP addresses, IP ranges and exact host names", () => {
	const allow = parse(
		" 127.0.0.1, 10.0.0.0/8 ,::1,fd00::/8, Ollama.Internal., ,db_1",
	)
	assert.deepStrictEqual([...allow.hostnames].sort(), [
		"db_1",
		"ollama.internal",
	])
	assert.strictEqual(allow.networks.length, 4)
	for (const entry of [
		"*",
		"*.internal",
		"http://localhost",
		"localhost:11434",
		"10.0.0.0/33",
		"a b",
	])
		assert.ok(Result.isFailure(OutboundPolicy.parse(entry)), entry)
	assert.ok(Result.isSuccess(OutboundPolicy.parse("")))
})

it("the address rule opens only the listed private targets", () => {
	const allowAddress = OutboundPolicy.allowAddress(
		parse("10.1.0.0/16,127.0.0.1,ollama.internal"),
	)
	assert.strictEqual(allowAddress("8.8.8.8", "dns.google"), true)
	assert.strictEqual(allowAddress("10.1.2.3", "a.example"), true)
	assert.strictEqual(allowAddress("10.2.0.1", "a.example"), false)
	assert.strictEqual(allowAddress("127.0.0.1", "127.0.0.1"), true)
	assert.strictEqual(allowAddress("::ffff:127.0.0.1", "a.example"), true)
	assert.strictEqual(allowAddress("127.0.0.2", "a.example"), false)
	assert.strictEqual(allowAddress("169.254.169.254", "a.example"), false)
	assert.strictEqual(allowAddress("192.168.1.9", "OLLAMA.internal."), true)
	assert.strictEqual(
		OutboundPolicy.allowAddress(OutboundPolicy.empty)("127.0.0.1", "localhost"),
		false,
	)
})

it("the environment sets the allow list, and a bad entry stops start-up", async () => {
	const load = (env: Record<string, string>) =>
		Effect.runPromise(
			EnvironmentConfiguration.load.pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							OPENBOT_DATABASE_URL: "postgres://localhost/openbot",
							OPENBOT_SECRET_KEYS: "test:" + "11".repeat(32),
							...env,
						}),
					),
				),
			),
		)
	const empty = await load({})
	assert.strictEqual(HashSet.size(empty.outboundAllow.hostnames), 0)
	assert.strictEqual(empty.outboundAllow.networks.length, 0)
	const listed = await load({ OPENBOT_OUTBOUND_ALLOW: "localhost" })
	assert.ok(HashSet.has(listed.outboundAllow.hostnames, "localhost"))
	await expect(
		load({ OPENBOT_OUTBOUND_ALLOW: "localhost:11434" }),
	).rejects.toThrow(
		/OPENBOT_OUTBOUND_ALLOW has an invalid entry "localhost:11434"/,
	)
})

it("the global guard blocks private targets for fetch and the Effect HTTP client", async () => {
	await using server = await startHttp((_req, res) => res.end("ok"))
	const before = getGlobalDispatcher()
	{
		await using runtime = ManagedRuntime.make(
			Layer.merge(
				OutboundGuard.layer(OutboundPolicy.empty),
				FetchHttpClient.layer,
			),
		)
		await runtime.runPromise(Effect.void)
		assert.notStrictEqual(getGlobalDispatcher(), before)
		await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toSatisfy(
			isBlocked,
		)
		await expect(fetch(`http://[::1]:${server.port}/`)).rejects.toSatisfy(
			isBlocked,
		)
		await expect(
			runtime.runPromise(HttpClient.get(`http://127.0.0.1:${server.port}/`)),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				error.cause instanceof TypeError &&
				isBlocked(error.cause) &&
				/OPENBOT_OUTBOUND_ALLOW/.test(String(error.cause.cause)),
		)
		assert.strictEqual(server.requests(), 0)
		const policy = await runtime.runPromise(readPolicy)
		assert.strictEqual(policy.allowAddress("127.0.0.1", "127.0.0.1"), false)
	}
	assert.strictEqual(getGlobalDispatcher(), before)
})

it("the global guard lets a listed address through and shares the rule", async () => {
	await using server = await startHttp((_req, res) => res.end("ok"))
	await using runtime = ManagedRuntime.make(
		OutboundGuard.layer(parse("127.0.0.1")),
	)
	await runtime.runPromise(Effect.void)
	const response = await fetch(`http://127.0.0.1:${server.port}/`)
	assert.strictEqual(await response.text(), "ok")
	const policy = await runtime.runPromise(readPolicy)
	assert.strictEqual(policy.allowAddress("127.0.0.1", "127.0.0.1"), true)
	assert.strictEqual(policy.allowAddress("127.0.0.2", "127.0.0.2"), false)
})

it("the guard checks the DNS answer and every redirect", async () => {
	await using server = await startHttp((req, res) => {
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `http://127.0.0.1:${server.port}/` })
			res.end()
		} else res.end("ok")
	})
	const blocked: Array<string> = []
	const dispatcher = OutboundGuard.dispatcher({
		allowAddress: OutboundPolicy.allowAddress(parse("listed.test")),
		lookup: (_hostname, _options, callback) =>
			callback(null, [{ address: "127.0.0.1", family: 4 }]),
		onBlocked: (hostname) => blocked.push(hostname),
	})
	try {
		const listed = await undiciFetch(`http://listed.test:${server.port}/`, {
			dispatcher,
		})
		assert.strictEqual(await listed.text(), "ok")
		await expect(
			undiciFetch(`http://other.test:${server.port}/`, { dispatcher }),
		).rejects.toSatisfy(isBlocked)
		await expect(
			undiciFetch(`http://listed.test:${server.port}/redirect`, { dispatcher }),
		).rejects.toSatisfy(isBlocked)
		assert.deepStrictEqual(blocked, ["other.test", "127.0.0.1"])
		assert.strictEqual(server.requests(), 2)
	} finally {
		await dispatcher.close()
	}
})
