import { Effect, Stream } from "effect"
import { NetworkError, type Reply } from "./Network.ts"

export const readBounded = Effect.fn("HttpNetwork.readBounded")(
	function* (options: { readonly reply: Reply; readonly maxBytes: number }) {
		let length = 0
		const chunks = yield* options.reply.body.pipe(
			Stream.mapEffect((chunk) => {
				length += chunk.byteLength
				return length > options.maxBytes
					? Effect.fail(
							new NetworkError({
								reason: "TooLarge",
								message:
									"Decoded document is larger than the configured byte limit",
							}),
						)
					: Effect.succeed(chunk)
			}),
			Stream.runCollect,
		)
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return new TextDecoder().decode(bytes)
	},
)
