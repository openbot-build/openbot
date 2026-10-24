// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { createSocket } from "node:dgram"
import { getServers, setServers } from "node:dns/promises"
import { syncBuiltinESMExports } from "node:module"
import { Effect } from "effect"
import { DomainControl, layer } from "../src/apps/DomainControl.ts"

// The test talks to a real UDP server, so it uses the real clock.
it.live(
	"the Node DNS proof adapter joins TXT fragments and tells missing records apart from resolver failures",
	() =>
		Effect.gen(function* () {
			const server = yield* Effect.acquireRelease(
				Effect.sync(() => createSocket("udp4")),
				(server) =>
					Effect.promise(
						() => new Promise<void>((resolve) => server.close(() => resolve())),
					),
			)
			let mode: "present" | "missing" | "unavailable" = "present"
			let requested = ""
			server.on("message", (query, remote) => {
				let end = 12
				let labels: ReadonlyArray<string> = []
				while (query[end] !== 0) {
					const length = query[end] ?? 0
					labels = [
						...labels,
						query.subarray(end + 1, end + 1 + length).toString(),
					]
					end += length + 1
				}
				requested = labels.join(".")
				end += 5
				const header = Buffer.alloc(12)
				query.copy(header, 0, 0, 2)
				header.writeUInt16BE(
					mode === "present" ? 0x8180 : mode === "missing" ? 0x8183 : 0x8182,
					2,
				)
				header.writeUInt16BE(1, 4)
				header.writeUInt16BE(mode === "present" ? 2 : 0, 6)
				const answer = (parts: ReadonlyArray<string>) => {
					const data = Buffer.concat(
						parts.map((part) => {
							const bytes = Buffer.from(part)
							return Buffer.concat([Buffer.from([bytes.length]), bytes])
						}),
					)
					const metadata = Buffer.alloc(12)
					metadata.writeUInt16BE(0xc00c, 0)
					metadata.writeUInt16BE(16, 2)
					metadata.writeUInt16BE(1, 4)
					metadata.writeUInt16BE(data.length, 10)
					return Buffer.concat([metadata, data])
				}
				server.send(
					Buffer.concat([
						header,
						query.subarray(12, end),
						...(mode === "present"
							? [
									answer(["openbot-verification=", "first"]),
									answer(["openbot-verification=second"]),
								]
							: []),
					]),
					remote.port,
					remote.address,
				)
			})
			yield* Effect.promise(
				() =>
					new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve)),
			)
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const previous = getServers()
					setServers(["127.0.0.1:" + server.address().port])
					syncBuiltinESMExports()
					return previous
				}),
				(previous) =>
					Effect.sync(() => {
						setServers(previous)
						syncBuiltinESMExports()
					}),
			)
			const read = Effect.flatMap(DomainControl, (domains) =>
				domains.tokens("publisher.example"),
			).pipe(Effect.provide(layer))
			assert.deepStrictEqual(yield* read, [
				"openbot-verification=first",
				"openbot-verification=second",
			])
			assert.strictEqual(requested, "_openbot-verification.publisher.example")
			mode = "missing"
			assert.deepStrictEqual(yield* read, [])
			mode = "unavailable"
			assert.strictEqual(
				(yield* Effect.flip(read))._tag,
				"DomainControlUnavailable",
			)
		}),
)
