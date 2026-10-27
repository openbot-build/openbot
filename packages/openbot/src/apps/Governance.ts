import { AppIndexApi, ConnectionsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Stream,
} from "effect"
import * as Background from "../app/Background.ts"
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
 * Effect, so this keeps the current list in a Ref and updates it when
 * the platform settings change.
 */
export const layer = Layer.effect(
	Governance,
	Effect.gen(function* () {
		const settings = yield* Settings
		const load = settings.platform.pipe(
			Effect.map((platform) =>
				HashMap.fromIterable(
					Arr.map(
						Option.match(platform, {
							onNone: () => [],
							onSome: (platform) => platform.document.appRestrictions,
						}),
						(restriction) =>
							[new URL(restriction.cardUrl).href, restriction] as const,
					),
				),
			),
		)
		const entries = yield* Ref.make(
			yield* load.pipe(
				Effect.orElseSucceed(() =>
					HashMap.empty<string, AppIndexApi.Restriction>(),
				),
			),
		)
		const reload = load.pipe(
			Effect.flatMap((next) => Ref.set(entries, next)),
			Background.logFailure(
				"OpenBot could not read the App restrictions. It keeps the current ones.",
			),
		)
		yield* Background.repeat(reload.pipe(Effect.delay("30 seconds")), {
			schedule: Schedule.forever,
			message: "OpenBot could not read the App restrictions.",
		})
		yield* Stream.filter(
			settings.changes,
			(scope) => scope.kind === "platform",
		).pipe(
			Stream.runForEach(() => reload),
			Effect.forkScoped,
		)
		const find = (cardUrl: string) =>
			HashMap.get(Ref.getUnsafe(entries), new URL(cardUrl).href)
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
