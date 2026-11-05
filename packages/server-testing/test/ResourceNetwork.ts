// Fault tests need to cut and hold actual TCP traffic.
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net"
import { Array as Arr, Effect } from "effect"

const listen = (server: Server) =>
	Effect.callback<number, Error>((resume) => {
		const failed = (error: Error) => resume(Effect.fail(error))
		server.once("error", failed)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", failed)
			const address = server.address()
			if (address === null || typeof address === "string") {
				resume(Effect.die("The test needs a TCP address."))
				return
			}
			resume(Effect.succeed(address.port))
		})
	})
const close = (server: Server) =>
	Effect.callback<void>((resume) => {
		server.close(() => resume(Effect.void))
	})

/** A real TCP peer counts open and closed physical connections. */
export const physical = Effect.gen(function* () {
	let opened = 0
	let closed = 0
	let peers: ReadonlyArray<Socket> = []
	const server = createServer((peer) => {
		opened++
		peers = Arr.append(peers, peer)
		peer.on("error", () => peer.destroy())
		peer.on("close", () => {
			closed++
			peers = Arr.filter(peers, (item) => item !== peer)
		})
		peer.resume()
	})
	const port = yield* Effect.acquireRelease(listen(server), () =>
		Effect.sync(() => {
			for (const peer of peers) peer.destroy()
		}).pipe(Effect.andThen(close(server))),
	)
	return { port, counts: Effect.sync(() => ({ opened, closed })) }
})

/** Native socket handles let a test break one node's traffic without changing its services. */
export const proxy = (targetPort: number) =>
	Effect.gen(function* () {
		let cut = false
		let hold = false
		let peers: ReadonlyArray<{
			readonly incoming: Socket
			readonly outgoing: Socket
		}> = []
		const server = createServer((incoming) => {
			if (cut) {
				incoming.destroy()
				return
			}
			const outgoing = createConnection({ host: "127.0.0.1", port: targetPort })
			const pair = { incoming, outgoing }
			peers = Arr.append(peers, pair)
			incoming.on("error", () => outgoing.destroy())
			outgoing.on("error", () => incoming.destroy())
			incoming.on("close", () => {
				outgoing.destroy()
				peers = Arr.filter(peers, (item) => item !== pair)
			})
			outgoing.on("close", () => incoming.destroy())
			incoming.pipe(outgoing)
			outgoing.pipe(incoming)
			if (hold) outgoing.pause()
		})
		const disconnect = Effect.sync(() => {
			cut = true
			for (const { incoming, outgoing } of peers) {
				incoming.destroy()
				outgoing.destroy()
			}
		})
		const port = yield* Effect.acquireRelease(listen(server), () =>
			disconnect.pipe(Effect.andThen(close(server))),
		)
		return {
			port,
			disconnect,
			reconnect: Effect.sync(() => {
				cut = false
			}),
			holdReplies: Effect.sync(() => {
				hold = true
				for (const { outgoing } of peers) outgoing.pause()
			}),
			releaseReplies: Effect.sync(() => {
				hold = false
				for (const { outgoing } of peers) outgoing.resume()
			}),
		}
	})
