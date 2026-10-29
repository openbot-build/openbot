import type { Mail as MailModel } from "@openbot-build/domain"
import { Context, DateTime, Effect, Layer, Option, Redacted } from "effect"
import * as Report from "../errors/Report.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { Settings } from "../settings/Settings.ts"
import { bindings } from "../settings/Platform.ts"
import * as Templates from "./Templates.ts"
import { Transport } from "./Transport.ts"

export interface Invitation {
	readonly id: string
	readonly email: string
	readonly organizationName: string
	readonly botName?: string
	readonly expiresAt: number
}

/** A delivery result never changes whether the invitation was saved. */
export class Mail extends Context.Service<
	Mail,
	{
		readonly invitation: (
			input: Invitation,
		) => Effect.Effect<MailModel.Delivery>
		readonly signInCode: (
			to: string,
			code: string,
		) => Effect.Effect<MailModel.Delivery>
		readonly test: (to: string) => Effect.Effect<MailModel.Delivery>
	}
>()("@openbot-build/openbot/mail/Mail") {}

export const layer = Layer.effect(
	Mail,
	Effect.gen(function* () {
		const settings = yield* Settings
		const secrets = yield* Secrets
		const transport = yield* Transport
		const report = yield* Report.make

		const send = Effect.fn("Mail.send")(function* (
			to: string,
			render: typeof Templates.renderTest,
		) {
			const platform = yield* settings.platform
			if (Option.isNone(platform)) return { status: "disabled" as const }
			const { document } = platform.value
			const mail = document.mail
			if (mail === undefined || mail === null)
				return { status: "disabled" as const }
			const content = yield* render({
				url: mail.invitationUrl ?? document.publicOrigin,
			})
			const password =
				mail.password === null
					? null
					: Redacted.make(
							yield* secrets.open(mail.password, bindings.mailPassword),
						)
			yield* transport.send(
				{
					host: mail.host,
					port: mail.port,
					security: mail.security,
					username: mail.username,
					password,
				},
				{ ...content, from: { address: mail.from, name: mail.fromName }, to },
			)
			return { status: "sent" as const }
		})

		const outcome = <E>(work: Effect.Effect<MailModel.Delivery, E>) =>
			work.pipe(
				Effect.catchCause((cause) =>
					report(
						"OpenBot could not send the email. It did not retry.",
						cause,
					).pipe(Effect.as({ status: "failed" } as const)),
				),
			)

		return Mail.of({
			invitation: (input) =>
				outcome(
					send(input.email, ({ url }) => {
						const link = new URL(url)
						if (link.pathname === "/") link.pathname = "/invitations"
						link.searchParams.set(
							input.botName === undefined ? "invitation" : "botInvitation",
							input.id,
						)
						return Templates.renderInvitation({
							organizationName: input.organizationName,
							...(input.botName === undefined
								? {}
								: { botName: input.botName }),
							email: input.email,
							url: link.toString(),
							expiresAt: DateTime.format(DateTime.makeUnsafe(input.expiresAt), {
								locale: "en-GB",
								day: "numeric",
								month: "long",
								year: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								hour12: false,
								timeZone: "UTC",
								timeZoneName: "short",
							}),
						})
					}),
				).pipe(Effect.annotateLogs({ invitationId: input.id })),
			test: (to) => outcome(send(to, Templates.renderTest)),
			signInCode: (to, code) =>
				outcome(
					send(to, ({ url }) => Templates.renderSignInCode({ url, code })),
				),
		})
	}),
)
