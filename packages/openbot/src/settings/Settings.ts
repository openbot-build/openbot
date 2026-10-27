import { Settings as Api } from "@openbot-build/api"
import { Context, type Effect, type Option, type Stream } from "effect"
import type {
	MemberDocument,
	OrganizationDocument,
	PlatformDocument,
	Scope,
	Snapshot,
} from "./Documents.ts"

/**
 * The settings that every instance of OpenBot shares. They live in the database.
 * Each instance keeps a cache. A change on any instance tells every instance
 * to read the settings again, so a change works everywhere at once.
 */
export class Settings extends Context.Service<
	Settings,
	{
		/** None until someone runs `openbot setup`. */
		readonly platform: Effect.Effect<
			Option.Option<Snapshot<PlatformDocument>>,
			Api.SettingsUnavailable
		>
		/** The defaults with version 0 when nobody changed them yet. */
		readonly organization: (
			organizationId: string,
		) => Effect.Effect<Snapshot<OrganizationDocument>, Api.SettingsUnavailable>
		/**
		 * Writes the platform settings for the first time.
		 * It does nothing and answers false when they already exist.
		 */
		readonly initializePlatform: (
			document: PlatformDocument,
		) => Effect.Effect<boolean, Api.SettingsUnavailable>
		/**
		 * Changes the platform settings. `change` gets the current document.
		 * The change fails with SettingsConflict when the version is not `expectedVersion`.
		 */
		readonly updatePlatform: <E>(
			expectedVersion: number,
			change: (current: PlatformDocument) => Effect.Effect<PlatformDocument, E>,
		) => Effect.Effect<
			Snapshot<PlatformDocument>,
			E | Api.SettingsConflict | Api.SettingsUnavailable | Api.SetupRequired
		>
		/** Writes the platform settings even when they exist. Only `openbot setup --force` uses it. */
		readonly replacePlatform: (
			document: PlatformDocument,
		) => Effect.Effect<Snapshot<PlatformDocument>, Api.SettingsUnavailable>
		readonly updateOrganization: <E>(
			organizationId: string,
			expectedVersion: number,
			change: (
				current: OrganizationDocument,
			) => Effect.Effect<OrganizationDocument, E>,
		) => Effect.Effect<
			Snapshot<OrganizationDocument>,
			E | Api.SettingsConflict | Api.SettingsUnavailable
		>
		/** The defaults with version 0 when the member did not change them yet. */
		readonly member: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<Snapshot<MemberDocument>, Api.SettingsUnavailable>
		readonly updateMember: <E>(
			organizationId: string,
			userId: string,
			expectedVersion: number,
			change: (current: MemberDocument) => Effect.Effect<MemberDocument, E>,
		) => Effect.Effect<
			Snapshot<MemberDocument>,
			E | Api.SettingsConflict | Api.SettingsUnavailable
		>
		/** Tells every instance that a scope changed, such as `signIn`. */
		readonly notify: (
			scope: Scope,
		) => Effect.Effect<void, Api.SettingsUnavailable>
		/**
		 * Each scope that changed, on any instance, after the subscription starts.
		 * A subscriber that reads too slowly loses its oldest changes, so it must
		 * also read the settings again from time to time.
		 */
		readonly changes: Stream.Stream<Scope>
	}
>()("@openbot-build/openbot/settings/Settings") {}
