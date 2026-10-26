import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
} from "effect"
import { AuthApi, DeveloperApi as Api } from "@openbot-build/api"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { DomainControl } from "../apps/DomainControl.ts"
import { scopeKey } from "../apps/DeveloperAccess.ts"
import { Auth } from "../auth/Auth.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

export class Proofs extends Context.Service<
	Proofs,
	{
		readonly tokens: (
			scope: Api.ManagementScope,
		) => Effect.Effect<ReadonlyArray<string>>
		readonly publish: (
			scope: Api.ManagementScope,
			tokens: ReadonlyArray<string>,
		) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/app/DevelopmentProofs/Proofs") {}
export const layer = Layer.effect(
	Proofs,
	Effect.map(
		Ref.make(HashMap.empty<string, ReadonlyArray<string>>()),
		(state) =>
			Proofs.of({
				tokens: (scope) =>
					Ref.get(state).pipe(
						Effect.map((values) =>
							Option.getOrElse(HashMap.get(values, scopeKey(scope)), () => []),
						),
					),
				publish: (scope, tokens) =>
					Ref.update(state, (values) =>
						HashMap.set(values, scopeKey(scope), tokens),
					),
			}),
	),
)
export const layerDomainControl = Layer.effect(
	DomainControl,
	Effect.map(Proofs, (proofs) =>
		DomainControl.of({
			tokens: (hostname) =>
				proofs.tokens({ _tag: "PublisherHostname", hostname }),
		}),
	),
)
/** Publishing a fixture is a normal authenticated write from the same origin. */
export const layerRoutes = Layer.unwrap(
	Effect.gen(function* () {
		const auth = yield* Auth
		const proofs = yield* Proofs
		const settings = yield* Settings
		return HttpRouter.add(
			"POST",
			"/development/apps/proofs",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const publicOrigin = yield* Platform.publicOrigin(settings)
				if (request.headers["origin"] !== publicOrigin)
					return HttpServerResponse.empty({ status: 403 })
				const cookie = request.cookies[AuthApi.SessionCookie]
				if (cookie === undefined)
					return HttpServerResponse.empty({ status: 401 })
				yield* auth.resolveSession(Redacted.make(cookie))
				const value = yield* request.text.pipe(
					Effect.flatMap(
						Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Struct({
									scope: Api.ManagementScope,
									tokens: Schema.Array(Schema.String),
								}),
							),
						),
					),
				)
				yield* proofs.publish(value.scope, value.tokens)
				return HttpServerResponse.empty({ status: 204 })
			}).pipe(
				Effect.catchTags({
					CredentialRejected: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 401 })),
					AuthUnavailable: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 503 })),
					SettingsUnavailable: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 503 })),
					SetupRequired: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 503 })),
					SchemaError: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 400 })),
					HttpServerError: () =>
						Effect.succeed(HttpServerResponse.empty({ status: 400 })),
				}),
			),
		)
	}),
)
