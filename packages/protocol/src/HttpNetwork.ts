import { Effect, Option, Stream } from "effect"
import { NetworkError, type Reply } from "./Network.ts"

const tooLarge = (message: string) =>
	NetworkError.make({ reason: "TooLarge", message })

/** Fails with TooLarge when the stream gives more than `maxBytes` bytes in all. */
export const limit =
	(maxBytes: number) =>
	<E, R>(
		self: Stream.Stream<Uint8Array, E, R>,
	): Stream.Stream<Uint8Array, E | NetworkError, R> =>
		Stream.mapAccumEffect(
			self,
			() => 0,
			(length, chunk) => {
				const next = length + chunk.byteLength
				return next > maxBytes
					? Effect.fail(
							tooLarge("Decoded body is larger than the configured byte limit"),
						)
					: Effect.succeed([next, [chunk]] as const)
			},
		)

const CR = 13
const LF = 10

/** Where an SSE (server-sent events) scan is after the last byte it saw. */
interface EventScan {
	/** Bytes since the last event boundary. */
	readonly size: number
	/** Line ends in a row. Two line ends make a blank line, which ends the event. */
	readonly ends: number
	/** The last byte was CR, so a next LF is part of the same CRLF line end. */
	readonly cr: boolean
}

/** Gives None when one event in the chunk goes over `maxBytes`. */
const scanEvents = (
	state: EventScan,
	chunk: Uint8Array,
	maxBytes: number,
): Option.Option<EventScan> => {
	// A loop over the bytes is the fast way to scan a chunk, so the state is local and mutable here.
	let { size, ends, cr } = state
	for (const byte of chunk) {
		if (byte === CR || (byte === LF && !cr)) ends++
		else if (byte !== LF) ends = 0
		cr = byte === CR
		if (ends >= 2) {
			size = 0
			ends = 0
		} else if (++size > maxBytes) return Option.none()
	}
	return Option.some({ size, ends, cr })
}

/**
 * Fails with TooLarge when one SSE event is larger than `maxBytes`. The count
 * starts again at each blank line, so a long stream of small events stays open.
 */
export const eventLimit =
	(maxBytes: number) =>
	<E, R>(
		self: Stream.Stream<Uint8Array, E, R>,
	): Stream.Stream<Uint8Array, E | NetworkError, R> =>
		Stream.mapAccumEffect(
			self,
			(): EventScan => ({ size: 0, ends: 0, cr: false }),
			(state, chunk) =>
				Option.match(scanEvents(state, chunk, maxBytes), {
					onNone: () =>
						Effect.fail(
							tooLarge("An event is larger than the configured byte limit"),
						),
					onSome: (next) => Effect.succeed([next, [chunk]] as const),
				}),
		)

export const readBounded = Effect.fn("HttpNetwork.readBounded")(
	function* (options: { readonly reply: Reply; readonly maxBytes: number }) {
		return yield* options.reply.body.pipe(
			limit(options.maxBytes),
			Stream.decodeText(),
			Stream.mkString,
		)
	},
)
