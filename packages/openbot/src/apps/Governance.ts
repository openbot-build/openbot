import { AppIndexApi, ConnectionsApi } from "@openbot-build/api"
import { Context, Effect, HashMap, Layer, Option, Stream } from "effect"
import { Settings } from "../settings/Settings.ts"

export class Governance extends Context.Service<
	Governance,
	{
		readonly find: (cardUrl: string) => Option.Option<AppIndexApi.Restriction>
		readonly check: (
			cardUrl: string,
		) => Effect.Effect<void, ConnectionsApi.AppRestricted>
	}
>()("@openbot-build/openbot/apps/Governance") {}
/**
 * The platform owns these restrictions, in its `appRestrictions` setting.
 * Ordinary user operations cannot change them. Many places ask without an
 * Effect, so this keeps the current list in a variable and updates it when
 * the platform settings change.
 */
export const layer = Layer.effect(
	Governance,
	Effect.gen(function* () {
		const settings = yield* Settings
		const load = settings.platform.pipe(
			Effect.map((platform) =>
				HashMap.fromIterable(
					Option.match(platform, {
						onNone: () => [],
						onSome: (platform) => platform.document.appRestrictions,
					}).map(
						(restriction) =>
							[new URL(restriction.cardUrl).href, restriction] as const,
					),
				),
			),
		)
		let entries = yield* load.pipe(
			Effect.orElseSucceed(() =>
				HashMap.empty<string, AppIndexApi.Restriction>(),
			),
		)
		const reload = load.pipe(
			Effect.tap((next) =>
				Effect.sync(() => {
					entries = next
				}),
			),
			Effect.catchCause((cause) =>
				Effect.logWarning(
					"OpenBot could not read the App restrictions. It keeps the current ones.",
					cause,
				),
			),
		)
		yield* Stream.merge(
			Stream.filter(settings.changes, (scope) => scope.kind === "platform"),
			Stream.tick("30 seconds"),
		).pipe(
			Stream.runForEach(() => reload),
			Effect.forkScoped,
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
