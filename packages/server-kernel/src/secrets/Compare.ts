// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no constant-time byte comparison.
import { createHash, timingSafeEqual } from "node:crypto"

export const sameSecret = (left: string, right: string): boolean => {
	const a = createHash("sha256").update(left).digest()
	const b = createHash("sha256").update(right).digest()
	return timingSafeEqual(a, b) && left.length === right.length
}
