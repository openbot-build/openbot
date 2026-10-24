import type { Settings as Api } from "@openbot-build/api"
import { DateTime } from "effect"
import {
	codeModeOf,
	filesOf,
	quotaOf,
	rateLimitOf,
	tokenRateOf,
	type FilesDocument,
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
		ceiling: document.ceiling,
		appRestrictions: document.appRestrictions,
		codeMode: codeModeOf(document),
		rateLimit: rateLimitOf(document),
		tokenRate: tokenRateOf(document),
		files: files(filesOf(document)),
		updatedAt: iso(snapshot.updatedAt),
	}
}

const files = (document: FilesDocument): Api.Files => {
	const { storage, ...stored } = document
	const limits = { ...stored, quotaBytes: quotaOf(document) }
	if (storage === null) return { ...limits, storage: null }
	const { secretAccessKey, secretAccessKeyHint, ...fields } = storage
	return {
		...limits,
		storage: {
			...fields,
			secretAccessKey: { set: true, hint: secretAccessKeyHint },
		},
	}
}

export const organization = (
	snapshot: Snapshot<OrganizationDocument>,
): Api.OrganizationSettings => ({
	...snapshot.document,
	tokenRate: tokenRateOf(snapshot.document),
	version: snapshot.version,
	updatedAt: iso(snapshot.updatedAt),
})

export const member = (
	snapshot: Snapshot<MemberDocument>,
): Api.MemberSettings => ({
	...snapshot.document,
	defaultBot: snapshot.document.defaultBot ?? null,
	version: snapshot.version,
	updatedAt: iso(snapshot.updatedAt),
})
