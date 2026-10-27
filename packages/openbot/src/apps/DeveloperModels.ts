import { AppIndex, Developers } from "@openbot-build/domain"
import { Discovery, Indexing } from "@openbot-build/protocol"
import { Schema } from "effect"

/** App protocol values attached to product state. These are not HTTP records. */
export const InspectionReport = Schema.Struct({
	...Developers.ReportState.fields,
	apps: Schema.Array(
		Schema.Struct({
			candidate: Discovery.Candidate,
			eligibility: Indexing.InspectionResult,
			stored: Schema.TaggedUnion({
				Known: { check: Schema.NullOr(AppIndex.Check) },
				Unknown: {},
			}),
		}),
	),
	stages: Schema.Array(Indexing.InspectionStage),
})
export type InspectionReport = typeof InspectionReport.Type
export const SavedReport = Schema.Struct({
	...Developers.SavedReportState.fields,
	report: InspectionReport,
})
export type SavedReport = typeof SavedReport.Type
export const ManagedApp = Schema.Struct({
	...Developers.ManagedAppState.fields,
	candidate: Discovery.Candidate,
})
export type ManagedApp = typeof ManagedApp.Type
export const ConnectionTest = Schema.Struct({
	...Developers.TestState.fields,
	candidate: Discovery.Candidate,
})
export type ConnectionTest = typeof ConnectionTest.Type
