import { Layer } from "effect"
import { DomainControl } from "@openbot-build/server-kernel/DomainControl"
import { Readers } from "@openbot-build/apps-contract/vaults/Readers"

/** Gives a test host the TXT records of each domain. */
export const domainControl = (service: typeof DomainControl.Service) =>
	Layer.succeed(DomainControl, service)

/** Gives a test host the readers of its secret providers. */
export const vaultReaders = (service: typeof Readers.Service) =>
	Layer.succeed(Readers, service)
