import * as Access from "@openbot-build/domain/Access"
import type { Settings as SettingsModel } from "@openbot-build/domain"
import { DateTime } from "effect"
import {
	codeModeOf,
	filesOf,
	quotaOf,
	rateLimitOf,
	tokenRateOf,
	delegationTimeLimitOf,
	operationsOf,
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
		registration: document.registration ?? Access.defaults,
		ceiling: document.ceiling,
		appRestrictions: document.appRestrictions,
		codeMode: codeModeOf(document),
		rateLimit: rateLimitOf(document),
		tokenRate: tokenRateOf(document),
		files: files(filesOf(document)),
		mail:
			document.mail == null
				? null
				: {
						...document.mail,
						password: { set: document.mail.password !== null, hint: null },
					},
		updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
	}
}

const files = (document: FilesDocument): SettingsModel.Files => {
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
): SettingsModel.OrganizationSettings => ({
	...snapshot.document,
	delegationTimeLimitMs: delegationTimeLimitOf(snapshot.document),
	...operationsOf(snapshot.document),
	tokenRate: tokenRateOf(snapshot.document),
	version: snapshot.version,
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
})

export const member = (
	snapshot: Snapshot<MemberDocument>,
): SettingsModel.MemberSettings => ({
	...snapshot.document,
	defaultBot: snapshot.document.defaultBot ?? null,
	version: snapshot.version,
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.updatedAt)),
})
