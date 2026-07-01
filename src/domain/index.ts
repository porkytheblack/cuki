import { Layer } from "effect"
import { CryptoService } from "../crypto/crypto.service"
import { KekProvider } from "../crypto/kek"
import { RepoLive } from "../repo"
import { AuditService } from "./audit.service"
import { AuthService } from "./auth.service"
import { KeyService } from "./key.service"
import { ManagementService } from "./management.service"
import { ServiceRegistry } from "./service-registry"
import { TokenService } from "./token.service"

export { AuditService, AuthService, KeyService, ManagementService, ServiceRegistry, TokenService }
export { CryptoService, KekProvider }
export * from "./context"

/** Crypto core (CryptoService + KekProvider both exposed). Requires AppConfig. */
export const CryptoLive = CryptoService.Default.pipe(Layer.provideMerge(KekProvider.Default))

/**
 * All domain services, plus the repos and crypto they sit on (re-exposed so the boot
 * sequence and management handlers can use them). Requires `AppConfig`.
 */
export const DomainLive = Layer.mergeAll(
  AuthService.Default,
  TokenService.Default,
  KeyService.Default,
  ServiceRegistry.Default,
  ManagementService.Default,
  AuditService.Default,
).pipe(Layer.provideMerge(CryptoLive), Layer.provideMerge(RepoLive))
