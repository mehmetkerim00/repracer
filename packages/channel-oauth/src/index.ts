// Р-175…Р-177 (шаг 43): подключение канала продавцом — OAuth, шифрование токена, классификация отказов
export { loadKeyring, ephemeralKeyring, sealToken, openToken, newState, stateDigest, type Keyring, type SealedToken } from './vault.ts';
export { amazonLwa, ebayOAuth, AMAZON_SELLER_CENTRAL, EBAY_ENDPOINTS, LWA_TOKEN_URL,
  type OAuthProvider, type OAuthChannel, type ConsentCallback, type ConsentRequest, type Fetch, type AmazonLwaConfig, type EbayOAuthConfig } from './providers.ts';
export { exchangeCode, refreshAccess, requestToken, classifyTokenError, type TokenResult, type TokenFailure } from './flow.ts';
export { redactSecrets } from './redact.ts';
export { createAuthorizationChecker, MASS_REVOCATION_MIN, type AuthorizationCheckOutcome, type AuthorizationCheckerOptions, type CredentialVaultPort, type CheckableCredential } from './checker.ts';
