import { AppIndexApi, ConnectionsApi } from "@openbot-build/platform-api"
import { Context, Effect, HashMap, Layer, Option, Schema } from "effect"
import { AppConfigurationError } from "./Secrets.ts"

export class Governance extends Context.Service<
	Governance,
	{
		readonly find: (cardUrl: string) => Option.Option<AppIndexApi.Restriction>
		readonly check: (
			cardUrl: string,
		) => Effect.Effect<void, ConnectionsApi.AppRestricted>
	}
>()("@openbot-build/platform/apps/Governance") {}
/** The deployment owns these restrictions. Normal user operations cannot change them. */
export const layer = (input: ReadonlyArray<AppIndexApi.Restriction> = []) =>
	Layer.effect(
		Governance,
		Effect.gen(function* () {
			const restrictions = yield* Schema.decodeEffect(
				Schema.Array(AppIndexApi.Restriction),
			)(input).pipe(
				Effect.mapError(() =>
					AppConfigurationError.make({
						message:
							"App restrictions require a Card URL, a public reason and an HTTPS appeal URL.",
					}),
				),
			)
			const entries = HashMap.fromIterable(
				restrictions.map(
					(restriction) =>
						[new URL(restriction.cardUrl).href, restriction] as const,
				),
			)
			const find = (cardUrl: string) =>
				HashMap.get(entries, new URL(cardUrl).href)
			return Governance.of({
				find,
				check: (cardUrl) =>
					Option.match(find(cardUrl), {
						onNone: () => Effect.void,
						onSome: (restriction) =>
							Effect.fail(ConnectionsApi.AppRestricted.make({ restriction })),
					}),
			})
		}),
	)
