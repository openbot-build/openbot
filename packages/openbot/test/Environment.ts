// Vitest sets NODE_ENV to "test" and TEST to "true". When better-auth sees them,
// it acts in other ways than in production: for example, it does not check the
// secret, and it gives a localhost IP when it cannot find the real one. The
// tests must see the same behavior as production, so this file takes the two
// values away before any test file loads.
delete process.env["NODE_ENV"]
delete process.env["TEST"]
