import type { Settings as Api } from "@openbot-build/api"
import { DateTime } from "effect"
import {
	codeModeOf,
	type MemberDocument,
	type OrganizationDocument,
	type PlatformDocument,
	type Snapshot,
} from "./Documents.ts"

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

/** The API form of the platform settings. Secrets only show whether they are set. */
export const platform = (
	snapshot: Snapshot<PlatformDocument>,
): Api.PlatformSettings => {
	const { document } = snapshot
	return {
		version: snapshot.version,
		publicOrigin: document.publicOrigin,
		identityProvider:
			document.identityProvider === null
				? null
				: {
						issuer: document.identityProvider.issuer,
						clientId: document.identityProvider.clientId,
						clientSecret: {
							set: document.identityProvider.clientSecret !== null,
							hint: document.identityProvider.clientSecretHint,
						},
					},
		organizationCreation: document.organizationCreation,
		policyCeiling: document.policyCeiling,
		appRestrictions: document.appRestrictions,
		codeMode: codeModeOf(document),
		updatedAt: iso(snapshot.updatedAt),
	}
}

export const organization = (
	snapshot: Snapshot<OrganizationDocument>,
): Api.OrganizationSettings => ({
	...snapshot.document,
	version: snapshot.version,
	updatedAt: iso(snapshot.updatedAt),
})

export const member = (
	snapshot: Snapshot<MemberDocument>,
): Api.MemberSettings => ({
	...snapshot.document,
	version: snapshot.version,
	updatedAt: iso(snapshot.updatedAt),
})
