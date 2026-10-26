/**
 * The worker thread that runs one Code Mode program in QuickJS.
 * QuickJS is a small JavaScript engine. Here it runs as WebAssembly, so the
 * program has no access to Node.js: no network, no files, no process.
 * The program can only call the App bindings that the host gives it. The host
 * answers each call. `vault` holds only references to secrets, never their values. This file is a worker entry point, so it starts work when it loads.
 */
import { type MessagePort, parentPort } from "node:worker_threads"
import { performance } from "node:perf_hooks"
// Each run starts a new worker, so the worker loads only the modules that it uses.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import variant from "@jitl/quickjs-singlefile-mjs-release-sync"
import * as Arr from "effect/Array"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
} from "quickjs-emscripten-core"
import type { FromWorker, Settled, ToWorker } from "./Protocol.ts"

/** Code that runs in QuickJS before the program. It builds `apps`, `vault`, `console`, the clock and random numbers. */
const prelude = `(() => {
	const host = globalThis.__openbot_host
	delete globalThis.__openbot_host
	const pending = new Map()
	const settle = (index, ok, text) => {
		const waiting = pending.get(index)
		pending.delete(index)
		if (waiting === undefined) return
		const value = JSON.parse(text)
		if (ok) return waiting.resolve(value)
		const error = new Error(value.message)
		error.name = value.name
		if (value.details !== undefined) error.details = value.details
		waiting.reject(error)
	}
	const known = new Set(host.bindings)
	const call = (binding, args) => {
		if (typeof binding !== "string" || !known.has(binding))
			throw new TypeError("There is no App binding with the name " + String(binding) + ".")
		const text = JSON.stringify(args === undefined ? {} : args)
		if (typeof text !== "string" || !text.startsWith("{"))
			throw new TypeError("The arguments of " + binding + " must be one plain object.")
		const index = host.call(binding, text)
		return new Promise((resolve, reject) => pending.set(index, { resolve, reject }))
	}
	const apps = { call }
	for (const binding of host.bindings) {
		const dot = binding.indexOf(".")
		const group = binding.slice(0, dot)
		const name = binding.slice(dot + 1)
		if (!Object.hasOwn(apps, group)) apps[group] = {}
		apps[group][name] = (args) => call(binding, args)
	}
	const vault = {}
	for (const item of host.vault) {
		const fields = {}
		for (const field of item.fields) fields[field] = "⟦vault:" + item.alias + "/" + field + "⟧"
		vault[item.alias] = Object.freeze(fields)
	}
	globalThis.vault = Object.freeze(vault)
	const show = (value) => {
		if (typeof value === "string") return value
		try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
	}
	const write = (...values) => host.log(values.map(show).join(" "))
	globalThis.console = Object.freeze({ log: write, info: write, warn: write, error: write, debug: write })
	globalThis.apps = Object.freeze(apps)
	let seed = host.seed >>> 0
	Math.random = () => {
		seed = (seed + 0x6d2b79f5) >>> 0
		let t = seed
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const clock = host.clock
	const NativeDate = Date
	globalThis.Date = class Date extends NativeDate {
		constructor(...args) { if (args.length === 0) super(clock); else super(...args) }
		static now() { return clock }
	}
	return settle
})()`

type Start = Extract<ToWorker, { type: "start" }>

/** A new QuickJS array of strings. The caller disposes it. */
const newStrings = (context: QuickJSContext, values: ReadonlyArray<string>) => {
	const array = context.newArray()
	Arr.forEach(values, (value, index) => {
		const handle = context.newString(value)
		context.setProp(array, index, handle)
		handle.dispose()
	})
	return array
}

/**
 * Runs the program. `results` gives the answers to each batch of App calls.
 * A defect is a bug of OpenBot, not of the program. It ends the worker, and
 * `NodeRuntime.runMain` writes its full cause to the server output.
 */
const run = (
	port: MessagePort,
	start: Start,
	results: Queue.Dequeue<ReadonlyArray<Settled>>,
) =>
	Effect.gen(function* () {
		const post = (message: FromWorker) =>
			Effect.sync(() => port.postMessage(message))
		const module = yield* Effect.promise(() =>
			newQuickJSWASMModuleFromVariant(variant),
		)
		const runtime = module.newRuntime()
		runtime.setMemoryLimit(start.limits.memoryBytes)
		runtime.setMaxStackSize(512 * 1024)
		// Only time inside QuickJS counts. Time that the host spends on App calls does not.
		let used = 0
		let since: number | undefined
		let timedOut = false
		runtime.setInterruptHandler(() => {
			if (since === undefined) return false
			timedOut = used + (performance.now() - since) > start.limits.timeoutMs
			return timedOut
		})
		const timed = <A>(work: () => A): A => {
			since = performance.now()
			try {
				return work()
			} finally {
				used += performance.now() - since
				since = undefined
			}
		}
		const context = runtime.newContext()
		let logs: ReadonlyArray<string> = []
		let logBytes = 0
		let next = 0
		let calls: Array<{ index: number; binding: string; arguments: string }> = []
		const failed = (
			reason: Extract<FromWorker, { type: "failed" }>["reason"],
			message: string,
		) => post({ type: "failed", reason, message, logs })
		const fromError = (handle: QuickJSHandle) =>
			Effect.suspend(() => {
				const error: unknown = context.dump(handle)
				handle.dispose()
				if (timedOut)
					return failed("Timeout", "The program used all of its time.")
				const text =
					typeof error === "object" && error !== null && "message" in error
						? String((error as { name?: unknown }).name ?? "Error") +
							": " +
							String(error.message)
						: String(error)
				if (/out of memory/i.test(text))
					return failed("Memory", "The program used all of its memory.")
				return failed("Error", text)
			})
		const host = context.newObject()
		const bindings = newStrings(context, start.bindings)
		context.setProp(host, "bindings", bindings)
		bindings.dispose()
		const vault = context.newArray()
		Arr.forEach(start.vault, (item, index) => {
			const entry = context.newObject()
			const alias = context.newString(item.alias)
			context.setProp(entry, "alias", alias)
			alias.dispose()
			const fields = newStrings(context, item.fields)
			context.setProp(entry, "fields", fields)
			fields.dispose()
			context.setProp(vault, index, entry)
			entry.dispose()
		})
		context.setProp(host, "vault", vault)
		vault.dispose()
		const seed = context.newNumber(start.seed)
		context.setProp(host, "seed", seed)
		seed.dispose()
		const clock = context.newNumber(start.clock)
		context.setProp(host, "clock", clock)
		clock.dispose()
		const call = context.newFunction("call", (binding, text) => {
			const index = next++
			calls.push({
				index,
				binding: context.getString(binding),
				arguments: context.getString(text),
			})
			return context.newNumber(index)
		})
		context.setProp(host, "call", call)
		call.dispose()
		const log = context.newFunction("log", (text) => {
			if (logBytes > start.limits.outputBytes) return
			const line = context.getString(text)
			logBytes += Buffer.byteLength(line)
			logs = [
				...logs,
				logBytes > start.limits.outputBytes
					? "[More output was cut off.]"
					: line,
			]
		})
		context.setProp(host, "log", log)
		log.dispose()
		context.setProp(context.global, "__openbot_host", host)
		host.dispose()
		const settle = context.unwrapResult(
			timed(() => context.evalCode(prelude, "prelude.js")),
		)
		const evaluated = timed(() =>
			context.evalCode(
				"(async () => {\n" + start.code + "\n})()",
				"program.js",
			),
		)
		if (evaluated.error !== undefined) return yield* fromError(evaluated.error)
		const program = evaluated.value
		for (;;) {
			const jobs = timed(() => runtime.executePendingJobs())
			if (jobs.error !== undefined) return yield* fromError(jobs.error)
			const state = context.getPromiseState(program)
			if (state.type === "fulfilled") {
				// This code is constant, so a failure here is a bug of OpenBot.
				const stringify = context.unwrapResult(
					timed(() =>
						context.evalCode(
							"(value) => JSON.stringify(value === undefined ? null : value)",
						),
					),
				)
				// The value of the program can make JSON.stringify fail, for example with a
				// circular reference or a BigInt. That is an error of the program.
				const result = timed(() =>
					context.callFunction(stringify, context.undefined, state.value),
				)
				stringify.dispose()
				state.value.dispose()
				if (result.error !== undefined) return yield* fromError(result.error)
				const text = result.value.consume((value) => context.getString(value))
				if (Buffer.byteLength(text) > start.limits.outputBytes)
					return yield* failed(
						"OutputTooLarge",
						"The program returned more data than the platform allows.",
					)
				return yield* post({ type: "done", value: text, logs })
			}
			if (state.type === "rejected") return yield* fromError(state.error)
			if (calls.length === 0)
				return yield* failed(
					"Error",
					"The program waits for something that never comes. Only App calls can make it wait.",
				)
			const batch = calls
			calls = []
			yield* post({ type: "calls", calls: batch })
			for (const result of yield* Queue.take(results)) {
				const settled = settleIn(context, settle, result, timed)
				if (settled !== undefined) return yield* fromError(settled)
			}
		}
	})

/** Gives one App result to the program. Answers an error handle when the program fails on it. */
const settleIn = (
	context: QuickJSContext,
	settle: QuickJSHandle,
	result: Settled,
	timed: <A>(work: () => A) => A,
): QuickJSHandle | undefined => {
	const index = context.newNumber(result.index)
	const ok = result.ok ? context.true : context.false
	const text = context.newString(result.ok ? result.value : result.error)
	const outcome = timed(() =>
		context.callFunction(settle, context.undefined, index, ok, text),
	)
	index.dispose()
	text.dispose()
	if (outcome.error !== undefined) return outcome.error
	outcome.value.dispose()
	return undefined
}

/** Takes the messages of the host. The first message starts the program. */
const main = Effect.gen(function* () {
	const port = parentPort
	if (port === null)
		return yield* Effect.die(
			new Error("The Code Mode worker must run in a worker thread."),
		)
	const started = yield* Deferred.make<Start>()
	const results = yield* Queue.unbounded<ReadonlyArray<Settled>>()
	yield* Effect.sync(() =>
		port.on("message", (message: ToWorker) => {
			if (message.type === "start")
				Deferred.doneUnsafe(started, Effect.succeed(message))
			else Queue.offerUnsafe(results, message.results)
		}),
	)
	yield* run(port, yield* Deferred.await(started), results)
})

NodeRuntime.runMain(main)
