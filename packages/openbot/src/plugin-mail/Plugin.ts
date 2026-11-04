/** The mail plugin: mail from the platform, with the SMTP settings of the platform. */
import { Mail } from "../identity-contract/mail/Mail.ts"
import { Transport } from "../identity-contract/mail/Transport.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as MailLayer from "./Mail.ts"

export const id = "mail"

/** The keys that this plugin publishes. */
export const publishes = [Mail] as const

export default Feature.make("@openbot-build/plugin-mail")
	.stage({
		inject: [Transport, Records, Secrets, Settings],
		services: MailLayer.layer,
		publishes,
	})
	.done()
