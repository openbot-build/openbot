import { Layer } from "effect"
import { DomainControl } from "@openbot-build/server-kernel/apps/DomainControl"
import { Readers } from "../../src/plugin-vaults/Readers.ts"

/** Gives a test host the TXT records of each domain. */
export const domainControl = (service: typeof DomainControl.Service) =>
	Layer.succeed(DomainControl, service)

/** Gives a test host the readers of its secret providers. */
export const vaultReaders = (service: typeof Readers.Service) =>
	Layer.succeed(Readers, service)
