---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when loading typed application configuration, environment variables, files, secrets, defaults, or custom providers with Config and ConfigProvider.
metadata:
  github-path: skills/effect-config
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: ca1e8cd742ba7c40c85c2c08ff3b5a4f7f6c9392
name: effect-config
---

# Effect configuration

Use Config to describe the shape and parsing rules of configuration, and
ConfigProvider to decide where values come from. Keep provider construction at
startup and pass the resulting service through a Layer.

## Describe intent, not process.env

A Config descriptor should say what the application needs and how it is
validated. Keep defaults explicit and distinguish an absent optional setting
from a required secret.

```ts
import { Config, Effect } from "effect";

const settings = Config.all({
  port: Config.Number("PORT").pipe(Config.withDefault(8080)),
  databaseUrl: Config.URL("DATABASE_URL"),
  debug: Config.Boolean("DEBUG").pipe(Config.withDefault(false)),
});

const loadSettings = Effect.gen(function* () {
  const value = yield* settings;
  return value;
});
```

The exact Config constructor names differ between Effect releases, so verify
the installed declarations before adding a new descriptor. The important
boundary is that parsing errors remain typed. `Config` is a re-runnable Effect;
if settings must be stable for a process, evaluate `settings` once at the
composition root and put the result in a service Layer or ManagedRuntime (or
use an explicit cache).

## Providers and secrets

Use the default environment provider when it matches deployment. Use a custom
ConfigProvider for layered files, test objects, or secret managers. Put
credentials in a Redacted value or a provider-specific secret service; never
print the raw configuration object.

Compose the provider Layer with the rest of the service graph. A test should
provide an in-memory provider and assert missing, malformed, defaulted, and
secret values separately.

## Review traps

- Reading process.env directly in domain code.
- Applying a default to a credential that must be present.
- Treating an empty string as equivalent to an absent variable without a
  documented policy.
- Re-reading configuration per request and making behavior change mid-flight.
- Logging a Config error that includes the secret value.

## References

- [Config API](https://effect.website/docs/v4/api/effect/Config)
- [ConfigProvider API](https://effect.website/docs/v4/api/effect/ConfigProvider)
- [Effect configuration guide](https://effect.website/docs)
- [Pinned Config source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Config.ts)
