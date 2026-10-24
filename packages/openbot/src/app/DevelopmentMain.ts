import { NodeCrypto, NodeRuntime } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"
import {
	Clock,
	Config,
	Effect,
	HashSet,
	Layer,
	Option,
	Result,
	Schedule,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as S3 from "../files/S3.ts"
import * as Development from "./Development.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import * as OutboundGuard from "../network/OutboundGuard.ts"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"

/** The local RustFS that devenv starts. Without it, development has no file storage. */
const fileStorage = Config.all({
	endpoint: Config.schema(Api.StorageEndpoint, "OPENBOT_DEV_S3_ENDPOINT"),
	bucket: Config.schema(Api.BucketName, "OPENBOT_DEV_S3_BUCKET"),
	accessKeyId: Config.String("OPENBOT_DEV_S3_ACCESS_KEY_ID"),
	secretAccessKey: Config.String("OPENBOT_DEV_S3_SECRET_ACCESS_KEY"),
}).pipe(
	Config.map((storage): Api.FileStorageInput => ({
		...storage,
		publicEndpoint: null,
		region: "us-east-1",
		forcePathStyle: true,
	})),
	Config.option,
)

/**
 * The guard blocks private addresses, and the local RustFS is one. So the
 * development entry opens the host of the storage, and only that host.
 */
const allowStorage = (
	allow: OutboundPolicy.Allow,
	storage: Api.FileStorageInput | undefined,
): OutboundPolicy.Allow =>
	storage === undefined
		? allow
		: Result.match(OutboundPolicy.parse(new URL(storage.endpoint).hostname), {
				onFailure: () => allow,
				onSuccess: (extra) => ({
					hostnames: HashSet.union(allow.hostnames, extra.hostnames),
					networks: [...allow.networks, ...extra.networks],
				}),
			})

/** Makes the bucket. RustFS may still start, so it tries again for a while. */
const createBucket = (storage: Api.FileStorageInput) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const now = yield* Clock.currentTimeMillis
		yield* S3.createBucket(
			client,
			{ ...storage, secretAccessKey: storage.secretAccessKey ?? "" },
			now,
		)
	}).pipe(
		Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
		Effect.catchCause((cause) =>
			Effect.logWarning("The development bucket was not made", cause),
		),
		// This entry point owns the bucket check, before the app starts.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(Layer.merge(FetchHttpClient.layer, NodeCrypto.layer)),
	)

NodeRuntime.runMain(
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			// Only the development entry reads the origin from the environment.
			// It has one instance, and it writes the platform settings itself.
			const publicOrigin = yield* Config.schema(
				Api.PublicOrigin,
				"OPENBOT_DEV_PUBLIC_ORIGIN",
			)
			const storage = Option.getOrUndefined(yield* fileStorage)
			return yield* Layer.launch(
				Layer.effectDiscard(
					Effect.logInfo(
						`Development login: POST ${publicOrigin}/auth/development/sign-in`,
					),
				).pipe(
					Layer.provideMerge(
						Development.layer({
							...settings,
							fileStorage: storage,
							auth: {
								mode: "development",
								publicOrigin,
								secret: Development.developmentSecret(settings.secretKeys),
							},
						}),
					),
					// The server starts at once. The bucket comes when RustFS is ready.
					Layer.provideMerge(
						Layer.effectDiscard(
							storage === undefined
								? Effect.void
								: Effect.forkScoped(createBucket(storage)),
						),
					),
					Layer.provide(
						OutboundGuard.layer(allowStorage(settings.outboundAllow, storage)),
					),
				),
			)
		}),
	),
)
