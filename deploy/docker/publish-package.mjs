import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

/** Store one commit-keyed file and verify the bytes read back from GitLab. */
export async function publishPackageFile({
	api,
	project,
	commit,
	token,
	tokenHeader = "JOB-TOKEN",
	directory,
	packageName,
	fileName,
	fetcher = fetch,
}) {
	if (!/^[0-9a-f]{40}$/.test(commit) || !/^\d+$/.test(project) || !token)
		throw new Error("A source commit and registry token are required")
	if (tokenHeader !== "JOB-TOKEN" && tokenHeader !== "PRIVATE-TOKEN")
		throw new Error("Use a known GitLab token header")
	const base = new URL(api)
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("Use the HTTPS GitLab API")
	if (
		!/^openbot-(source|image)$/.test(packageName) ||
		!/^(source|platform)\.tar\.gz$|^release\.json$/.test(fileName)
	)
		throw new Error("Use a known release package and file")
	const bytes = await readFile(directory + "/" + fileName)
	const checksum = createHash("sha256").update(bytes).digest("hex")
	const url =
		api.replace(/\/$/, "") +
		"/projects/" +
		project +
		"/packages/generic/" +
		packageName +
		"/" +
		commit +
		"/" +
		fileName
	const headers = { [tokenHeader]: token }
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
		if (!upload.ok) throw new Error("Release package upload failed")
		await upload.arrayBuffer()
		existing = await get()
	}
	if (!existing.ok) throw new Error("Release package cannot be verified")
	const stored = createHash("sha256")
		.update(Buffer.from(await existing.arrayBuffer()))
		.digest("hex")
	if (stored !== checksum)
		throw new Error("Existing release package differs from the tested commit")
	return { url, checksum }
}
