import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { test } from "node:test"
import {
	SessionView,
	AppDiscoveryFailed,
	AppDiscoveryResult,
	AuthApi,
} from "@openbot-build/platform-api"
import { Schema } from "effect"
import * as PostgresTest from "./PostgresTest.ts"

test(
	"built development entry migrates and runs, and production keeps missing-model behavior",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const publicOrigin = "https://localhost:8443"
		const {
			OPENBOT_TLS_CERT: _cert,
			OPENBOT_TLS_KEY: _key,
			...inherited
		} = process.env
		const env = {
			...inherited,
			OPENBOT_DATABASE_URL: database.url,
			OPENBOT_APP_ENCRYPTION_KEY:
				"1111111111111111111111111111111111111111111111111111111111111111",
			OPENBOT_HOST: "127.0.0.1",
			OPENBOT_PORT: "0",
			OPENBOT_PUBLIC_ORIGIN: publicOrigin,
			BETTER_AUTH_SECRET: "DevelopmentEntrySecretMustStayStable1234567890",
			OPENBOT_DEV_MODE: "1",
		}
		const start = async (
			entry: "DevelopmentMain" | "Main",
			readyMessage?: string,
		) => {
			const probe = createServer()
			probe.listen(0, "127.0.0.1")
			await once(probe, "listening")
			const address = probe.address()
			assert.ok(address !== null && typeof address !== "string")
			await new Promise<void>((resolve, reject) =>
				probe.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			)
			const child = spawn(process.execPath, [`dist/${entry}.js`], {
				env: { ...env, OPENBOT_PORT: String(address.port) },
				stdio: ["ignore", "pipe", "pipe"],
			})
			let output = ""
			let errors = ""
			const stop = async () => {
				if (child.exitCode !== null || child.signalCode !== null) return
				const exited = once(child, "exit")
				child.kill("SIGINT")
				await exited
			}
			try {
				const address = await new Promise<string>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`Entry did not start: ${errors}`)),
						10000,
					)
					child.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString()
						const address = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
							output,
						)?.[1]
						if (
							address !== undefined &&
							(readyMessage === undefined || output.includes(readyMessage))
						) {
							clearTimeout(timer)
							resolve(address)
						}
					})
					child.stderr.on("data", (chunk: Buffer) => {
						errors += chunk.toString()
					})
					child.once("error", (error) => {
						clearTimeout(timer)
						reject(error)
					})
					child.once("exit", (code) => {
						clearTimeout(timer)
						reject(new Error(`Entry exited with ${code}: ${output}\n${errors}`))
					})
				})
				return { address, stop, output: () => output }
			} catch (error) {
				await stop()
				throw error
			}
		}
		try {
			execFileSync(process.execPath, ["dist/Migrate.js"], {
				env,
				stdio: "pipe",
			})
			const development = await start(
				"DevelopmentMain",
				"Development login: " + publicOrigin + "/auth/login",
			)
			try {
				const login = await fetch(development.address + "/auth/login", {
					redirect: "manual",
				})
				assert.equal(login.status, 303)
				assert.match(
					development.output(),
					/Development login: https:\/\/localhost:8443\/auth\/login/,
				)
				const cookie = login.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
					.split(";")[0]!
				const headers = {
					cookie,
					origin: publicOrigin,
					"content-type": "application/json",
				}
				const create = async (address: string) =>
					Schema.decodeUnknownSync(SessionView)(
						await (
							await fetch(address + "/v1/sessions", {
								method: "POST",
								headers,
								body: JSON.stringify({}),
							})
						).json(),
					)
				const discover = (address: string, input: string) =>
					fetch(address + "/v1/apps/discover", {
						method: "POST",
						headers,
						body: JSON.stringify({ input }),
					})
				const discovered = await discover(
					development.address,
					"app.development.test",
				)
				assert.equal(discovered.status, 200)
				const candidate = Schema.decodeUnknownSync(
					Schema.toCodecJson(AppDiscoveryResult),
				)(await discovered.json())
				assert.ok(candidate._tag === "Single")
				assert.equal(
					candidate.candidate.card.name,
					"app.development.test/simulated-app",
				)
				const unknown = await discover(
					development.address,
					"unknown.development.test",
				)
				assert.equal(unknown.status, 422)
				assert.equal(
					Schema.decodeUnknownSync(AppDiscoveryFailed)(await unknown.json())
						.reason,
					"NoDeclaration",
				)
				const agent = await create(development.address)
				const answer = await fetch(
					development.address + `/v1/sessions/${agent.session.id}/turns`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							input: "Verify the built entry",
							expected: agent.session.revision,
							stream: true,
						}),
					},
				)
				assert.equal(answer.status, 200)
				assert.match(
					await answer.text(),
					/Development response: Verify the built entry/,
				)
				await development.stop()
				const production = await start("Main")
				try {
					const blocked = await discover(
						production.address,
						"https://127.0.0.1/card.json",
					)
					assert.equal(blocked.status, 422)
					assert.equal(
						Schema.decodeUnknownSync(AppDiscoveryFailed)(await blocked.json())
							.reason,
						"BlockedTarget",
					)
					const ordinary = await create(production.address)
					const unavailable = await fetch(
						production.address + `/v1/sessions/${ordinary.session.id}/turns`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								input: "No implicit simulator",
								expected: ordinary.session.revision,
							}),
						},
					)
					assert.equal(unavailable.status, 503)
					assert.equal(
						production.output().includes("Development login:"),
						false,
					)
				} finally {
					await production.stop()
				}
			} finally {
				await development.stop()
			}
		} finally {
			await database.close()
		}
	},
)
