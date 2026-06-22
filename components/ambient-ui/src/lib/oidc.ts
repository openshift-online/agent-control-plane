import * as client from "openid-client"
import { env } from "@/lib/env"

const DISCOVERY_TTL_MS = 5 * 60 * 1000

let cachedConfig: client.Configuration | null = null
let cachedAt = 0

async function getOIDCConfig(): Promise<client.Configuration> {
  if (cachedConfig && Date.now() - cachedAt < DISCOVERY_TTL_MS) {
    return cachedConfig
  }

  // Always fetch discovery from the backend issuer (cluster-internal DNS)
  // The pod can't reach SSO_FRONTEND_ISSUER_URL (localhost:18856)
  const issuerURL = env.SSO_ISSUER_URL
  const clientId = env.SSO_CLIENT_ID
  const clientSecret = env.SSO_CLIENT_SECRET

  if (!issuerURL || !clientId || !clientSecret) {
    throw new Error("SSO_ISSUER_URL, SSO_CLIENT_ID, and SSO_CLIENT_SECRET must be set")
  }

  const serverUrl = new URL(issuerURL)
  const useInsecure = serverUrl.protocol === "http:"

  // With hostname-backchannel-dynamic, the discovery response's issuer
  // (public URL) differs from the fetch URL (internal). openid-client v6
  // rejects this mismatch. Fetch discovery manually and construct config.
  // See: https://github.com/panva/openid-client/issues/737
  const wellKnownUrl = `${issuerURL}/.well-known/openid-configuration`
  const resp = await fetch(wellKnownUrl)
  if (!resp.ok) {
    throw new Error(`OIDC discovery failed: ${resp.status}`)
  }
  const metadata: unknown = await resp.json()

  // Keycloak returns browser-facing URLs using KC_HOSTNAME (e.g. http://localhost/sso).
  // When port-forwarding the service for local development, the browser needs to reach Keycloak on
  // a port-forwarded URL instead of the internal service URL.
  // Rewrite the discovered issuer prefix to SSO_FRONTEND_ISSUER_URL for browser endpoints.
  if (env.SSO_FRONTEND_ISSUER_URL) {
    const metadataObj = metadata as Record<string, unknown>
    const discoveredIssuer = typeof metadataObj.issuer === 'string' ? metadataObj.issuer : ''
    const frontendIssuer = env.SSO_FRONTEND_ISSUER_URL

    // Normalize trailing slashes for comparison - both Keycloak discovery output and the env var
    // should be consistent, but handle mismatches defensively
    const normalizeUrl = (url: string) => url.replace(/\/+$/, '')
    const normalizedDiscovered = normalizeUrl(discoveredIssuer)
    const normalizedFrontend = normalizeUrl(frontendIssuer)

    if (normalizedDiscovered && normalizedDiscovered !== normalizedFrontend) {
      const browserEndpoints = [
        'issuer',
        'authorization_endpoint',
        'end_session_endpoint',
        'check_session_iframe',
      ]

      browserEndpoints.forEach((key) => {
        if (typeof metadataObj[key] === 'string') {
          // Replace using normalized discovered issuer, but preserve original trailing slash behavior
          const original = metadataObj[key] as string
          metadataObj[key] = original.replace(discoveredIssuer, frontendIssuer)
        }
      })
    }
  }

  const config = new client.Configuration(
    metadata as client.ServerMetadata,
    clientId,
    clientSecret,
  )

  if (useInsecure) {
    client.allowInsecureRequests(config)
  }

  cachedConfig = config
  cachedAt = Date.now()
  return config
}

export async function buildAuthorizationUrl(redirectUri: string): Promise<{
  url: string
  codeVerifier: string
  state: string
}> {
  // Fetch config with rewritten URLs (backend fetch, frontend URLs)
  const config = await getOIDCConfig()
  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()

  const redirectTo = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  })

  return { url: redirectTo.href, codeVerifier, state }
}

export async function exchangeCode(
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string,
): Promise<{
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
}> {
  const config = await getOIDCConfig()
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
  })

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    idToken: tokens.id_token ?? "",
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 300),
  }
}

export async function refreshOIDCTokens(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
}> {
  const config = await getOIDCConfig()
  const tokens = await client.refreshTokenGrant(config, refreshToken)

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    idToken: tokens.id_token ?? "",
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 300),
  }
}

export async function getEndSessionUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string> {
  // Config already has frontend URLs due to rewriting
  const config = await getOIDCConfig()
  const metadata = config.serverMetadata()
  const endSessionEndpoint = metadata.end_session_endpoint
  if (!endSessionEndpoint) {
    return postLogoutRedirectUri
  }
  const url = new URL(String(endSessionEndpoint))
  if (idTokenHint) {
    url.searchParams.set("id_token_hint", idTokenHint)
  } else {
    url.searchParams.set("client_id", env.SSO_CLIENT_ID || "")
  }
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri)
  return url.href
}
