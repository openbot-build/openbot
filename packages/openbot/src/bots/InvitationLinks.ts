import { BotSharing as BotsApi } from "@openbot-build/domain"

import { Crypto, Effect, String as Str } from "effect"
import { Base64Url, Hex } from "effect/encoding"
import type { LinkSecret } from "../organization/Organization.ts"
import { Secrets } from "../secrets/Secrets.ts"

/** The sealed secret is bound to its hash, so it cannot move to another invitation. */
const binding = (hash: string) => "bot_invitation:" + hash

/**
 * Takes the services once, and gives the functions for the secrets of
 * invitation links. Their effects need no services.
 */
export const make = Effect.gen(function* () {
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	/** OpenBot finds an invitation link by the SHA-256 hash of its secret. */
	const hashOf = (secret: string) =>
		crypto.digest("SHA-256", new TextEncoder().encode(secret)).pipe(
			// A platform without SHA-256 is broken.
			Effect.orDie,
			Effect.map(Hex.encode),
		)
	return {
		hashOf,
		/** Makes the secret of a new invitation link. */
		create: Effect.gen(function* () {
			// A platform without secure random numbers is broken.
			const random = yield* crypto.randomBytes(32).pipe(Effect.orDie)
			const secret = BotsApi.InvitationSecretPrefix + Base64Url.encode(random)
			const hash = yield* hashOf(secret)
			const link: LinkSecret = {
				hash,
				sealed: yield* secrets.seal(secret, binding(hash)),
				prefix: Str.takeLeft(secret, BotsApi.InvitationSecretPrefix.length + 8),
			}
			return { secret, link }
		}),
		/** Opens the sealed secret of an invitation link again. */
		open: (link: LinkSecret) => secrets.open(link.sealed, binding(link.hash)),
	}
})

/** The full address of a link: the public origin, the path, then `#` and the secret. */
export const urlOf = (
	publicOrigin: string,
	path: string | null,
	secret: string | null,
) =>
	path === null || secret === null ? null : publicOrigin + path + "#" + secret
