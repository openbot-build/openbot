import { Predicate } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:https"
import type { RequestListener } from "node:http"

export const startHttps = async (handler: RequestListener) => {
	const directory = await mkdtemp(join(tmpdir(), "protocol-test-"))
	const keyPath = join(directory, "key.pem")
	const certPath = join(directory, "cert.pem")
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	)
	const key = await readFile(keyPath)
	const ca = await readFile(certPath)
	const server = createServer({ key, cert: ca }, handler)
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const address = server.address()
	if (!Predicate.isObject(address)) throw new Error("Expected a TCP address")
	const origin = `https://localhost:${address.port}`
	const ipOrigin = `https://127.0.0.1:${address.port}`
	return {
		server,
		origin,
		ipOrigin,
		ca,
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			)
			await rm(directory, { recursive: true, force: true })
		},
	}
}
