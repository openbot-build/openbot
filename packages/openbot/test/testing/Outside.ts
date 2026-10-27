import { Layer } from "effect"
import { DomainControl } from "../../src/apps/DomainControl.ts"
import { Readers } from "../../src/vaults/Readers.ts"

/** Gives a test host the TXT records of each domain. */
export const domainControl = (service: typeof DomainControl.Service) =>
	Layer.succeed(DomainControl, service)

/** Gives a test host the readers of its secret providers. */
export const vaultReaders = (service: typeof Readers.Service) =>
	Layer.succeed(Readers, service)
