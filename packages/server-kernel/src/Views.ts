import type { Settings as SettingsModel } from "@openbot-build/domain"
import { DateTime } from "effect"
import {
	type FilesDocument,
	type MemberDocument,
	type OrganizationDocument,
	type PlatformDocument,
	type Snapshot,
} from "./Documents.ts"

/** The API form of the platform settings. Secrets only show whether they are set. */
export const platform = (
	snapshot: Snapshot<PlatformDocument>,
): SettingsModel.PlatformSettings => {
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
		registration: document.registration,
		ceiling: document.ceiling,
		appRestrictions: document.appRestrictions,
		codeMode: document.codeMode,
		rateLimit: document.rateLimit,
		tokenRate: document.tokenRate,
		files: files(document.files),
		mail:
			document.mail === null
				? null
				: {
						...document.mail,
						password: { set: document.mail.password !== null, hint: null },
					},
		updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
	}
}

const files = (document: FilesDocument): SettingsModel.Files => {
	const { storage, ...limits } = document
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
): SettingsModel.OrganizationSettings => ({
	...snapshot.document,
	version: snapshot.version,
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
})

export const member = (
	snapshot: Snapshot<MemberDocument>,
): SettingsModel.MemberSettings => ({
	...snapshot.document,
	version: snapshot.version,
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
})
