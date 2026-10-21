import { createHash } from "node:crypto"
import { readFile, appendFile } from "node:fs/promises"

export async function publishSource({
	api,
	project,
	commit,
	token,
	directory,
	fetcher = fetch,
}) {
	if (!/^[0-9a-f]{40}$/.test(commit) || !/^\d+$/.test(project) || !token)
		throw new Error("A protected CI identity is required")
	const base = new URL(api)
	if (base.protocol !== "https:" || base.username || base.password)
		throw new Error("Use the HTTPS GitLab API")
	const bytes = await readFile(directory + "/source.tar.gz")
	const checksum = createHash("sha256").update(bytes).digest("hex")
	const url =
		api.replace(/\/$/, "") +
		"/projects/" +
		project +
		"/packages/generic/openbot-source/" +
		commit +
		"/source.tar.gz"
	const headers = { "JOB-TOKEN": token }
	const get = () =>
		fetcher(url, {
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(60000),
		})
	let existing = await get()
	if (existing.status === 404) {
		await existing.arrayBuffer()
		const upload = await fetcher(url, {
			method: "PUT",
			headers,
			body: bytes,
			redirect: "error",
			signal: AbortSignal.timeout(60000),
		})
		if (!upload.ok) throw new Error("Source package upload failed")
		await upload.arrayBuffer()
		existing = await get()
	}
	if (!existing.ok) throw new Error("Source package cannot be verified")
	const stored = createHash("sha256")
		.update(Buffer.from(await existing.arrayBuffer()))
		.digest("hex")
	if (stored !== checksum)
		throw new Error("Existing source package differs from the tested commit")
	return { url, checksum }
}
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
