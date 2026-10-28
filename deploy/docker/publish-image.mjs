import { appendFile, readFile, writeFile } from "node:fs/promises"
import { publishPackageFile } from "./publish-package.mjs"

/** Publish the tested image archive and a record that binds it to the same source. */
export async function publishImage({ imageId, source, ...options }) {
	if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
		throw new Error("The tested Docker image ID is required")
	const expectedSource =
		options.api.replace(/\/$/, "") +
		"/projects/" +
		options.project +
		"/packages/generic/openbot-source/" +
		options.commit +
		"/source.tar.gz"
	if (
		source?.url !== expectedSource ||
		!/^[0-9a-f]{64}$/.test(source?.checksum)
	)
		throw new Error("The verified source must use the same commit")
	const archive = await publishPackageFile({
		...options,
		packageName: "openbot-image",
		fileName: "platform.tar.gz",
	})
	const record = {
		version: 1,
		commit: options.commit,
		image: {
			tag: "openbot-platform:" + options.commit,
			id: imageId,
			architecture: "amd64",
			nodeVersion: "26.12.1",
			archive,
		},
		source,
	}
	await writeFile(
		options.directory + "/release.json",
		JSON.stringify(record, null, 2) + "\n",
	)
	const manifest = await publishPackageFile({
		...options,
		packageName: "openbot-image",
		fileName: "release.json",
	})
	return { archive, manifest }
}

if (import.meta.main) {
	const directory = ".devenv/release"
	const metadata = Object.fromEntries(
		(await readFile(directory + "/image.env", "utf8"))
			.trim()
			.split("\n")
			.map((line) => {
				const index = line.indexOf("=")
				return [line.slice(0, index), line.slice(index + 1)]
			}),
	)
	const result = await publishImage({
		api: process.env.CI_API_V4_URL,
		project: process.env.CI_PROJECT_ID,
		commit: process.env.CI_COMMIT_SHA,
		token: process.env.CI_JOB_TOKEN,
		directory,
		imageId: metadata.OPENBOT_IMAGE_ID,
		source: {
			url: metadata.OPENBOT_SOURCE_URL,
			checksum: metadata.OPENBOT_SOURCE_SHA256,
		},
	})
	await appendFile(
		directory + "/image.env",
		`OPENBOT_IMAGE_ARCHIVE_URL=${result.archive.url}\nOPENBOT_IMAGE_ARCHIVE_SHA256=${result.archive.checksum}\n` +
			`OPENBOT_RELEASE_MANIFEST_URL=${result.manifest.url}\nOPENBOT_RELEASE_MANIFEST_SHA256=${result.manifest.checksum}\n`,
	)
}
