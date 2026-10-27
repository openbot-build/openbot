import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import test from "node:test"

const sha = "a".repeat(40)
const script = fileURLToPath(new URL("./ci-platform.sh", import.meta.url))
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "openbot-release-"))
	mkdirSync(join(root, "bin"))
	mkdirSync(join(root, "deploy/docker"), { recursive: true })
	for (const [name, content] of Object.entries({
		git: `#!/bin/sh\ncase "$1" in\n rev-parse) echo "$CI_COMMIT_SHA";;\n status) printf %s "$FAKE_DIRTY";;\n archive) printf "source-$CI_COMMIT_SHA";;\nesac\n`,
		docker: `#!/bin/sh\ncase "$1" in\n image) case "$*" in *Architecture*) echo amd64;; *) echo "$CI_COMMIT_SHA";; esac;;\n save) printf "image-$CI_COMMIT_SHA";;\nesac\n`,
		hadolint: "#!/bin/sh\nexit 0\n",
	}))
		writeFileSync(join(root, "bin", name), content, { mode: 0o755 })
	writeFileSync(
		join(root, "deploy/docker/check.sh"),
		`#!/bin/sh\nprintf %s "$OPENBOT_RELEASE" > checked-release\nexit "\${FAKE_CHECK_EXIT:-0}"\n`,
	)
	writeFileSync(join(root, "LICENSE"), "AGPL-3.0-only\n")
	writeFileSync(join(root, "upstream.json"), "{}\n")
	return root
}
const run = (root, extra = {}) =>
	spawnSync("bash", [script], {
		cwd: root,
		env: {
			...process.env,
			PATH: join(root, "bin") + ":" + process.env.PATH,
			CI_COMMIT_SHA: sha,
			CI_COMMIT_REF_PROTECTED: "false",
			FAKE_DIRTY: "",
			...extra,
		},
		encoding: "utf8",
	})

test("release archives are created only after native image checks pass", () => {
	const root = fixture()
	try {
		const failed = run(root, { FAKE_CHECK_EXIT: "42" })
		assert.equal(failed.status, 42, failed.stderr)
		assert.equal(existsSync(join(root, ".devenv/release/source.tar.gz")), false)
		assert.equal(readFileSync(join(root, "checked-release"), "utf8"), sha)
		const passed = run(root)
		assert.equal(passed.status, 0, passed.stderr)
		assert.equal(
			gunzipSync(
				readFileSync(join(root, ".devenv/release/source.tar.gz")),
			).toString(),
			"source-" + sha,
		)
		assert.equal(
			gunzipSync(
				readFileSync(join(root, ".devenv/release/platform.tar.gz")),
			).toString(),
			"image-" + sha,
		)
		assert.match(
			readFileSync(join(root, ".devenv/release/image.env"), "utf8"),
			new RegExp("OPENBOT_RELEASE=" + sha),
		)
		for (const line of readFileSync(
			join(root, ".devenv/release/SHA256SUMS"),
			"utf8",
		)
			.trim()
			.split("\n")) {
			const [expected, file] = line.split(/\s+/)
			assert.equal(
				createHash("sha256")
					.update(readFileSync(join(root, file)))
					.digest("hex"),
				expected,
			)
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
test("a dirty checkout cannot publish an image whose source archive differs", () => {
	const root = fixture()
	try {
		const result = run(root, {
			FAKE_DIRTY: " M packages/openbot/src/app/Main.ts",
		})
		assert.notEqual(result.status, 0)
		assert.equal(existsSync(join(root, "checked-release")), false)
		assert.equal(existsSync(join(root, ".devenv/release/source.tar.gz")), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
