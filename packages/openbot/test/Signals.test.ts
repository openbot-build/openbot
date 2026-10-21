// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, ManagedRuntime, Queue, Redacted } from "effect"
import * as Signals from "../src/agents/Signals.ts"
import * as Fence from "../src/execution/ExecutionFence.ts"
import * as Work from "../src/execution/InstanceWork.ts"

test("queued signals keep account and instance leases until consumed or closed", async (t) => {
	let phase = "ACTIVE",
		serial = 0
	const leases = new Set<string>()
	t.mock.method(
		globalThis,
		"fetch",
		async (url: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(url)).pathname.split("/").at(-1),
				body = JSON.parse(String(init?.body))
			if (path === "release") {
				leases.delete(body.leaseId)
				return Response.json({ released: true })
			}
			const allowed =
				body.accountId === "alice" &&
				(phase === "ACTIVE" ||
					(phase === "DRAINING" &&
						path === "acquire" &&
						body.intent !== "admit"))
			const leaseId = String(++serial)
			if (allowed && path === "acquire") leases.add(leaseId)
			return Response.json({ allowed, epoch: 1, phase, leaseId })
		},
	)
	const runtime = ManagedRuntime.make(
		Signals.layer.pipe(
			Layer.provideMerge(
				Fence.layer({
					origin: "http://authority.test",
					token: Redacted.make("test-only"),
					backend: "openbot",
				}),
			),
			Layer.provideMerge(Work.layer),
		),
	)
	const signal = Signals.Signal.RequestChanged({
		organizationId: "org",
		request: "request",
	})
	try {
		await runtime.runPromise(
			Fence.admit(
				"alice",
				Effect.flatMap(Signals.Signals, (signals) => signals.publish(signal)),
			),
		)
		assert.equal(
			leases.size,
			1,
			"The request lease ended but its queued continuation is still durable",
		)
		assert.equal(
			await runtime.runPromise(
				Effect.flatMap(Fence.ExecutionFence, (fence) => fence.active("alice")),
			),
			1,
		)
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(Work.InstanceWork, (work) => work.status),
				)
			).activeTasks,
			1,
		)
		phase = "DRAINING"
		await runtime.runPromise(
			Effect.flatMap(Work.InstanceWork, (work) => work.quiesce),
		)
		const envelope = await runtime.runPromise(
			Effect.flatMap(Signals.Signals, (signals) => Queue.take(signals.queue)),
		)
		let consumed = false
		await runtime.runPromise(
			envelope.reservation
				.run(
					Fence.guard(
						"alice",
						"continue",
						Effect.sync(() => {
							consumed = true
						}),
					).pipe(
						Effect.provideService(Fence.CurrentExecution, envelope.execution),
					),
				)
				.pipe(Effect.ensuring(envelope.release)),
		)
		assert.equal(consumed, true)
		assert.equal(leases.size, 0)
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(Work.InstanceWork, (work) => work.status),
				)
			).activeTasks,
			0,
		)
		phase = "ACTIVE"
		await runtime.runPromise(
			Effect.flatMap(Work.InstanceWork, (work) => work.resume),
		)
		await runtime.runPromise(
			Fence.admit(
				"alice",
				Effect.flatMap(Signals.Signals, (signals) => signals.publish(signal)),
			),
		)
		assert.equal(leases.size, 1)
	} finally {
		await runtime.dispose()
	}
	assert.equal(
		leases.size,
		0,
		"Closing the queue releases unconsumed account leases",
	)
})
