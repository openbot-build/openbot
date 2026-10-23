import { createHash, randomBytes } from "node:crypto"
import { BotsApi } from "@openbot-build/api"
import { Effect } from "effect"
import type { LinkSecret } from "../organization/Organization.ts"
import { Secrets } from "../secrets/Secrets.ts"

/** OpenBot finds an invitation link by the SHA-256 hash of its secret. */
export const hashOf = (secret: string) =>
	createHash("sha256").update(secret).digest("hex")

/** The sealed secret is bound to its hash, so it cannot move to another invitation. */
const binding = (hash: string) => "bot_invitation:" + hash

/** Makes the secret of a new invitation link. */
export const make = Effect.gen(function* () {
	const secrets = yield* Secrets
	const secret =
		BotsApi.InvitationSecretPrefix + randomBytes(32).toString("base64url")
	const hash = hashOf(secret)
	const link: LinkSecret = {
		hash,
		sealed: yield* secrets.seal(secret, binding(hash)),
		prefix: secret.slice(0, BotsApi.InvitationSecretPrefix.length + 8),
	}
	return { secret, link }
})

/** Opens the sealed secret of an invitation link again. */
export const open = (link: LinkSecret) =>
	Effect.flatMap(Secrets, (secrets) =>
		secrets.open(link.sealed, binding(link.hash)),
	)

/** The full address of a link: the public origin, the path, then `#` and the secret. */
export const urlOf = (
	publicOrigin: string,
	path: string | null,
	secret: string | null,
) =>
	path === null || secret === null ? null : publicOrigin + path + "#" + secret
