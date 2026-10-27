import { Channels as Domain } from "@openbot-build/domain"
import { type Crypto, Effect, Redacted } from "effect"
import { Base64Url } from "effect/encoding"
import type { Credentials } from "./Channels.ts"

/** The input credentials, with the secrets that OpenBot makes itself. */
export const fromInput = (
	crypto: Crypto.Crypto,
	value: Domain.CredentialsInput,
	current?: Credentials,
): Effect.Effect<Credentials> =>
	Effect.gen(function* () {
		const input = value
		switch (input.kind) {
			case "slack":
			case "lark":
				return input
			case "telegram":
				return {
					...input,
					// A new token keeps the webhook secret, so Telegram does not need it again.
					webhookSecret:
						current?.kind === "telegram"
							? current.webhookSecret
							: Redacted.make(Base64Url.encode(yield* crypto.randomBytes(32))),
				}
			case "custom":
				return {
					...input,
					secret: current?.kind === "custom" ? current.secret : null,
				}
		}
	}).pipe(Effect.orDie)
