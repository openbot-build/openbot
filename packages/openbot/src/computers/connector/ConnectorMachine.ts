import { ComputersApi } from "@openbot-build/api"
import { Duration, Effect, Schema } from "effect"
import { ComputerCallFailed, Machine } from "../Computer.ts"
import type { Connectors } from "./Connectors.ts"

/** The reply of a connector must have the form of the operation, or the call failed. */
const as =
	<S extends Schema.Top>(schema: S) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(() =>
				ComputerCallFailed.make({
					message: "The machine sent an answer of the wrong form.",
					retry: false,
				}),
			),
		)

/**
 * A Computer that is a machine of a person, reached through its connector.
 * It cannot pause and has no public ports. It has a desktop only when its connector says so.
 */
export const make = (input: {
	readonly computerId: string
	readonly desktop: boolean
	readonly connectors: Connectors["Service"]
	readonly online: boolean
}) => {
	const call = (
		operation: ComputersApi.ConnectorCall["operation"],
		wait?: Duration.Duration,
	) => input.connectors.call(input.computerId, operation, wait)
	return new Machine({
		shell: {
			start: (request) => input.connectors.start(input.computerId, request),
			read: (path, encoding) =>
				call({ _tag: "Read", path, encoding }).pipe(
					Effect.flatMap(as(ComputersApi.FileContent)),
				),
			write: (file) => call({ _tag: "Write", file }).pipe(Effect.asVoid),
			list: (path) =>
				call({ _tag: "List", path }).pipe(
					Effect.flatMap(as(Schema.Array(ComputersApi.FileEntry))),
				),
			remove: (path) => call({ _tag: "Remove", path }).pipe(Effect.asVoid),
		},
		...(input.desktop
			? {
					desktop: {
						screenshot: call({ _tag: "Screenshot" }).pipe(
							Effect.flatMap(as(ComputersApi.Screenshot)),
						),
						act: (actions) =>
							call({ _tag: "Desktop", actions }).pipe(Effect.asVoid),
						stream: Effect.fail(
							ComputerCallFailed.make({
								message: "A connected machine cannot stream its desktop.",
								retry: false,
							}),
						),
					},
				}
			: {}),
		state: Effect.succeed(input.online ? "running" : "starting"),
		// OpenBot only forgets the machine. The machine itself stays as it is.
		destroy: input.connectors.close(input.computerId),
	})
}
