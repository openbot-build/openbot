/** The mail plugin: mail from the platform, with the SMTP settings of the platform. */
import { Mail } from "@openbot-build/identity-contract/mail/Mail"
import { Transport } from "@openbot-build/identity-contract/mail/Transport"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
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
