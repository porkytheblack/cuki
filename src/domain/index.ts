import { Layer } from "effect"
import { CryptoService } from "../crypto/crypto.service"
import { KekProvider } from "../crypto/kek"
import { RepoLive } from "../repo"
import { AuditService } from "./audit.service"
import { AuthService } from "./auth.service"
import { KeyService } from "./key.service"
import { ManagementService } from "./management.service"
import { RateLimiter } from "./ratelimit"
import { ServiceRegistry } from "./service-registry"
import { TokenService } from "./token.service"

export { AuditService, AuthService, KeyService, ManagementService, RateLimiter, ServiceRegistry, TokenService }
export { CryptoService, KekProvider }
export * from "./context"

/** Crypto core (CryptoService + KekProvider both exposed). Requires AppConfig. */
export const CryptoLive = CryptoService.Default.pipe(Layer.provideMerge(KekProvider.Default))

/**
 * All domain services, plus the repos, crypto, audit, and rate limiter they sit on (all
 * re-exposed so the boot sequence and handlers can use them). Requires `AppConfig`.
 *
 * `AuditService` and `RateLimiter` are `provideMerge`d (not just merged) so TokenService —
 * which depends on both — is wired to them, while they remain in the output for handlers.
 */
export const DomainLive = Layer.mergeAll(
  AuthService.Default,
  TokenService.Default,
  KeyService.Default,
  ServiceRegistry.Default,
  ManagementService.Default,
).pipe(
  Layer.provideMerge(AuditService.Default),
  Layer.provideMerge(RateLimiter.Default),
  Layer.provideMerge(CryptoLive),
  Layer.provideMerge(RepoLive),
)
