import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, Layer } from "effect"

/** Docker and Compose put each secret in a file in this folder. */
export const directory = "/run/secrets"

/**
 * Reads a setting from the file `<rootPath>/<NAME>` when no environment variable sets it.
 * A missing folder or file means the setting is not set. An empty file also means it is not set.
 */
export const layer = (rootPath: string = directory) =>
	ConfigProvider.layerAdd(ConfigProvider.fromDir({ rootPath })).pipe(
		Layer.provide(NodeServices.layer),
	)
