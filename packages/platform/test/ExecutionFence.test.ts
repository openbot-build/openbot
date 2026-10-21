import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, ManagedRuntime, Redacted, Scope, Exit } from "effect"
import {
	CurrentExecution,
	ExecutionFence,
	layer,
} from "../src/execution/ExecutionFence.ts"

test("leases retain the admitted epoch and block drain if release fails", async (t) => {
	let phase = "E_ACTIVE",
		epoch = 7,
		releaseFails = false,
		serial = 0
	const requests: {
		path: string
		body: { epoch?: number; intent?: string }
	}[] = []
	t.mock.method(
		globalThis,
		"fetch",
		async (url: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(url)).pathname.split("/").at(-1)!
			const body = JSON.parse(String(init?.body))
			requests.push({ path, body })
			if (path === "release")
				return new Response(JSON.stringify({ released: true }), {
					status: releaseFails ? 503 : 200,
				})
			const allowed =
				phase === "E_ACTIVE" ||
				(phase === "DRAINING" && body.intent !== "admit" && path !== "resolve")
			return new Response(
				JSON.stringify({
					allowed:
						allowed && (body.epoch === undefined || body.epoch === epoch),
					epoch,
					phase,
					...(path === "acquire" ? { leaseId: String(++serial) } : {}),
				}),
			)
		},
	)
	const runtime = ManagedRuntime.make(
		layer({
			origin: "http://authority.test",
			token: Redacted.make("test-only"),
			backend: "e",
		}),
	)
	try {
		let captured: import("../src/execution/ExecutionFence.ts").Lease | undefined
		await runtime.runPromise(
			Effect.flatMap(ExecutionFence, (fence) =>
				fence.admit(
					"user",
					Effect.gen(function* () {
						captured = yield* CurrentExecution
						phase = "DRAINING"
						yield* fence.guard("user", "write", Effect.void)
						assert.equal(yield* fence.active("user"), 1)
					}),
				),
			),
		)
		assert.ok(captured!)
		assert.equal(
			await runtime.runPromise(
				Effect.flatMap(ExecutionFence, (fence) => fence.active("user")),
			),
			0,
		)
		await assert.rejects(
			runtime.runPromise(
				Effect.flatMap(ExecutionFence, (fence) =>
					fence.admit("user", Effect.void),
				),
			),
		)
		const resolutions = requests.filter((r) => r.path === "resolve").length
		epoch = 8
		await assert.rejects(
			runtime.runPromise(
				Effect.flatMap(ExecutionFence, (fence) =>
					fence.guard("user", "send", Effect.void),
				).pipe(Effect.provideService(CurrentExecution, captured!)),
			),
		)
		assert.equal(
			requests.filter((r) => r.path === "resolve").length,
			resolutions,
		)
		phase = "E_ACTIVE"
		releaseFails = true
		await runtime.runPromise(
			Effect.flatMap(ExecutionFence, (fence) =>
				fence.admit("user", Effect.void),
			),
		)
		assert.equal(
			await runtime.runPromise(
				Effect.flatMap(ExecutionFence, (fence) => fence.active("user")),
			),
			1,
		)
	} finally {
		await runtime.dispose()
	}
})

test("stream leases last until the owning scope closes", async (t) => {
	let count = 0
	t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo) => {
		const path = new URL(String(url)).pathname
		if (path.endsWith("release")) {
			count--
			return Response.json({ released: true })
		}
		count++
		return Response.json({
			allowed: true,
			epoch: 1,
			phase: "E_ACTIVE",
			leaseId: "stream",
		})
	})
	const runtime = ManagedRuntime.make(
		layer({
			origin: "http://authority.test",
			token: Redacted.make("test-only"),
			backend: "e",
		}),
	)
	const scope = await Effect.runPromise(Scope.make())
	try {
		await runtime.runPromise(
			Effect.flatMap(ExecutionFence, (fence) =>
				fence.guardScoped("user", "send", Effect.void),
			).pipe(
				Effect.provideService(CurrentExecution, {
					accountId: "user",
					backend: "e",
					epoch: 1,
					leaseId: "parent",
					intent: "admit",
				}),
				Effect.provideService(Scope.Scope, scope),
			),
		)
		assert.equal(count, 1)
		await Effect.runPromise(Scope.close(scope, Exit.void))
		assert.equal(count, 0)
	} finally {
		await runtime.dispose()
	}
})
