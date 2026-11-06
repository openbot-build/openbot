import { fileURLToPath } from "node:url"

/**
 * The folder of the SQL migrations. This module is one folder below the
 * package root in the source, in the build, and in the bundle of the image, so
 * the same relative path works in all of them.
 */
export const migrationsFolder = fileURLToPath(
	new URL("../migrations", import.meta.url),
)
