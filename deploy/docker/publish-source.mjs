import { appendFile } from "node:fs/promises"
import { publishPackageFile } from "./publish-package.mjs"

export const publishSource = (options) =>
	publishPackageFile({
		...options,
		packageName: "openbot-source",
		fileName: "source.tar.gz",
	})

if (import.meta.main) {
	const result = await publishSource({
		api: process.env.CI_API_V4_URL,
		project: process.env.CI_PROJECT_ID,
		commit: process.env.CI_COMMIT_SHA,
		token: process.env.CI_JOB_TOKEN,
		directory: ".devenv/release",
	})
	await appendFile(
		".devenv/release/image.env",
		`OPENBOT_SOURCE_URL=${result.url}\nOPENBOT_SOURCE_SHA256=${result.checksum}\n`,
	)
}
