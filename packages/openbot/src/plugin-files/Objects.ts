import { Files } from "@openbot-build/domain"
import { Effect, Option, Redacted } from "effect"
import { SecureRandom } from "effect/crypto"
import { HttpClient } from "effect/http"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import {
	filesDefaults,
	filesOf,
	type FilesDocument,
} from "../server-kernel/settings/Documents.ts"
import { bindings } from "../server-kernel/settings/Platform.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as S3 from "./S3.ts"

/** The shared object storage boundary. Secrets are opened only for a call. */
export const make = Effect.gen(function* () {
	const settings = yield* Settings
	const secrets = yield* Secrets
	const client = yield* HttpClient.HttpClient
	const crypto = yield* SecureRandom.SecureRandom
	const config = settings.platform.pipe(
		Effect.map(
			Option.match({
				onNone: () => filesDefaults,
				onSome: (snapshot) => filesOf(snapshot.document),
			}),
		),
	)
	const target = (document: FilesDocument) =>
		Effect.gen(function* () {
			const storage = document.storage
			if (storage === null)
				return yield* Files.FilesDisabled.make({
					message: "The platform has no file storage.",
				})
			return {
				target: {
					endpoint: storage.endpoint,
					region: storage.region,
					bucket: storage.bucket,
					accessKeyId: storage.accessKeyId,
					secretAccessKey: Redacted.make(
						yield* secrets.open(
							storage.secretAccessKey,
							bindings.fileStorageSecret,
						),
					),
					forcePathStyle: storage.forcePathStyle,
				} satisfies S3.Target,
				publicEndpoint: storage.publicEndpoint ?? storage.endpoint,
			}
		})
	const remove = (objectKey: string, now: number) =>
		Effect.gen(function* () {
			const location = yield* target(yield* config)
			yield* S3.remove(client, location.target, objectKey, now).pipe(
				Effect.provideService(SecureRandom.SecureRandom, crypto),
			)
		})
	return { config, target, remove }
})
