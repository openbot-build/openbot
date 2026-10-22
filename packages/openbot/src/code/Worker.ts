/**
 * The worker thread that runs one Code Mode program in QuickJS.
 * QuickJS is a small JavaScript engine. Here it runs as WebAssembly, so the
 * program has no access to Node.js: no network, no files, no process.
 * The program can only call the App bindings that the host gives it. The host
 * answers each call. This file is a worker entry point, so it starts work when it loads.
 */
import { parentPort } from "node:worker_threads"
import { performance } from "node:perf_hooks"
import variant from "@jitl/quickjs-singlefile-mjs-release-sync"
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
} from "quickjs-emscripten-core"
import type { FromWorker, Settled, ToWorker } from "./Protocol.ts"

const port = parentPort
if (port === null)
	throw new Error("The Code Mode worker must run in a worker thread.")

/** Code that runs in QuickJS before the program. It builds `apps`, `console`, the clock and random numbers. */
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

const send = (message: FromWorker) => port.postMessage(message)

const run = async (start: Extract<ToWorker, { type: "start" }>) => {
	const module = await newQuickJSWASMModuleFromVariant(variant)
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
	) => send({ type: "failed", reason, message, logs })
	const fromError = (handle: QuickJSHandle) => {
		const error: unknown = context.dump(handle)
		handle.dispose()
		if (timedOut) return failed("Timeout", "The program used all of its time.")
		const text =
			typeof error === "object" && error !== null && "message" in error
				? String((error as { name?: unknown }).name ?? "Error") +
					": " +
					String(error.message)
				: String(error)
		if (/out of memory/i.test(text))
			return failed("Memory", "The program used all of its memory.")
		return failed("Error", text)
	}
	try {
		const host = context.newObject()
		const bindings = context.newArray()
		start.bindings.forEach((binding, index) => {
			const value = context.newString(binding)
			context.setProp(bindings, index, value)
			value.dispose()
		})
		context.setProp(host, "bindings", bindings)
		bindings.dispose()
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
		if (evaluated.error !== undefined) return fromError(evaluated.error)
		const program = evaluated.value
		for (;;) {
			const jobs = timed(() => runtime.executePendingJobs())
			if (jobs.error !== undefined) return fromError(jobs.error)
			const state = context.getPromiseState(program)
			if (state.type === "fulfilled") {
				const text = context.getString(
					context
						.unwrapResult(
							timed(() =>
								context.evalCode(
									"(value) => JSON.stringify(value === undefined ? null : value)",
								),
							),
						)
						.consume((stringify) =>
							context.unwrapResult(
								context.callFunction(stringify, context.undefined, state.value),
							),
						),
				)
				state.value.dispose()
				if (Buffer.byteLength(text) > start.limits.outputBytes)
					return failed(
						"OutputTooLarge",
						"The program returned more data than the platform allows.",
					)
				return send({ type: "done", value: text, logs })
			}
			if (state.type === "rejected") return fromError(state.error)
			if (calls.length === 0)
				return failed(
					"Error",
					"The program waits for something that never comes. Only App calls can make it wait.",
				)
			const batch = calls
			calls = []
			send({ type: "calls", calls: batch })
			const results = await answers()
			if (results === undefined) return
			for (const result of results) {
				const settled = settleIn(context, settle, result, timed)
				if (settled !== undefined) return fromError(settled)
			}
		}
	} catch (error) {
		if (timedOut) return failed("Timeout", "The program used all of its time.")
		const text = error instanceof Error ? error.message : String(error)
		if (/out of memory|memory/i.test(text))
			return failed("Memory", "The program used all of its memory.")
		return failed("Error", text)
	}
}

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

let waiting: ((results: ReadonlyArray<Settled> | undefined) => void) | undefined
const answers = () =>
	new Promise<ReadonlyArray<Settled> | undefined>((resolve) => {
		waiting = resolve
	})

port.on("message", (message: ToWorker) => {
	if (message.type === "start") void run(message)
	else if (message.type === "results") {
		const resolve = waiting
		waiting = undefined
		resolve?.(message.results)
	}
})
