import {
  CmsPublicSiteSchema,
  CmsSetupStatusSchema,
  type CmsPublicSite,
  type CmsSetupStatus,
} from './responseSchemas'
import { Type, type Static } from '@sinclair/typebox'
import { readEnvelope, assertOk } from '@core/http'

interface CmsSetupInput {
  siteName: string
  email: string
  password: string
}

interface CmsLoginInput {
  email: string
  password: string
}

interface CmsMfaVerifyInput {
  code: string
}

interface CmsStepUpInput {
  password: string
  mfaCode?: string
}

export const CmsStepUpAuthModeSchema = Type.Union([
  Type.Literal('required'),
  Type.Literal('disabled'),
])

export type CmsStepUpAuthMode = Static<typeof CmsStepUpAuthModeSchema>

export const CmsStepUpWindowMinutesSchema = Type.Union([
  Type.Literal(5),
  Type.Literal(15),
  Type.Literal(30),
  Type.Literal(60),
])

export type CmsStepUpWindowMinutes = Static<typeof CmsStepUpWindowMinutesSchema>

export const CmsCurrentUserRoleSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.String(),
  isSystem: Type.Boolean(),
  capabilities: Type.Array(Type.String()),
})

export type CmsCurrentUserRole = Static<typeof CmsCurrentUserRoleSchema>

export const CmsCurrentUserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  role: CmsCurrentUserRoleSchema,
  capabilities: Type.Array(Type.String()),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  failedLoginCount: Type.Number(),
  lockedUntil: Type.Union([Type.String(), Type.Null()]),
  passwordUpdatedAt: Type.Union([Type.String(), Type.Null()]),
  mfaEnabled: Type.Boolean(),
  mfaEnabledAt: Type.Union([Type.String(), Type.Null()]),
  mfaRecoveryCodesRemaining: Type.Number(),
  stepUpAuthMode: CmsStepUpAuthModeSchema,
  stepUpWindowMinutes: CmsStepUpWindowMinutesSchema,
  /**
   * Identifier of the media asset backing the avatar, or null when the user
   * relies on the Gravatar identicon fallback.
   */
  avatarMediaId: Type.Union([Type.String(), Type.Null()]),
  /**
   * Resolved public path of the avatar image (e.g. `/uploads/abc-portrait.png`)
   * when one is uploaded, otherwise null. The Gravatar fallback URL is built
   * client-side from `gravatarHash`.
   */
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  /**
   * SHA-256 hex of the normalized email — drives the Gravatar identicon URL.
   * Always populated for authenticated users.
   */
  gravatarHash: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type CmsCurrentUser = Static<typeof CmsCurrentUserSchema>

const CurrentUserEnvelope = Type.Object(
  {
    user: CmsCurrentUserSchema,
    role: Type.Optional(CmsCurrentUserRoleSchema),
    capabilities: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
)

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const CmsLoginResponseSchema = Type.Object({
  ok: Type.Boolean(),
  mfaRequired: Type.Optional(Type.Boolean()),
})

export async function getCmsSetupStatus(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsSetupStatus> {
  const res = await fetchImpl(`${basePath}/setup/status`, {
    method: 'GET',
    credentials: 'include',
  })
  return readEnvelope(res, CmsSetupStatusSchema, `CMS setup status failed with ${res.status}`)
}

/**
 * Read the unauthenticated site-identity (name + favicon URL) the login /
 * setup screen renders as its brand row. Safe to call before login; never
 * exposes a page tree or user data. Resolves to `{ name: null, faviconUrl:
 * null }` for a freshly-cloned install where no site has been created yet.
 */
export async function getCmsPublicSite(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublicSite> {
  const res = await fetchImpl(`${basePath}/public-site`, {
    method: 'GET',
    credentials: 'include',
  })
  return readEnvelope(res, CmsPublicSiteSchema, `CMS public site identity failed with ${res.status}`)
}

export async function setupCms(
  input: CmsSetupInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/setup`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  await assertOk(res, `CMS setup failed with ${res.status}`)
}

export async function loginCms(
  input: CmsLoginInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ mfaRequired: boolean }> {
  const res = await fetchImpl(`${basePath}/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, CmsLoginResponseSchema, `CMS login failed with ${res.status}`)
  return { mfaRequired: body.mfaRequired === true }
}

export async function verifyCmsMfa(
  input: CmsMfaVerifyInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/auth/mfa/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  await assertOk(res, `CMS MFA verification failed with ${res.status}`)
}

export async function logoutCms(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/logout`, {
    method: 'POST',
    credentials: 'include',
  })
  await assertOk(res, `CMS logout failed with ${res.status}`)
}

export async function probeCmsSession(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<boolean> {
  const res = await fetchImpl(`${basePath}/me`, {
    method: 'GET',
    credentials: 'include',
  })

  if (res.ok) return true
  if (res.status === 401) return false
  await assertOk(res, `CMS session check failed with ${res.status}`)
  return false
}

export async function getCurrentCmsUser(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/me`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, CurrentUserEnvelope, `CMS current user failed with ${res.status}`)
  return body.user
}

// ─── Self-profile mutations (Account → Profile tab) ─────────────────────────

const MeAvatarEnvelope = Type.Object(
  { user: CmsCurrentUserSchema },
  { additionalProperties: true },
)

const MeUserEnvelope = Type.Object(
  { user: CmsCurrentUserSchema },
  { additionalProperties: true },
)

const PasswordChangeEnvelope = Type.Object(
  {
    user: CmsCurrentUserSchema,
    revokedSessions: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const TotpStartEnvelope = Type.Object({
  secret: Type.String(),
  otpauthUrl: Type.String(),
})

const RecoveryCodesEnvelope = Type.Object(
  {
    user: CmsCurrentUserSchema,
    recoveryCodes: Type.Array(Type.String()),
  },
  { additionalProperties: true },
)

interface CmsStepUpSettingsInput {
  mode: CmsStepUpAuthMode
  windowMinutes: CmsStepUpWindowMinutes
}

/**
 * Upload a new avatar image for the current user. The file is sent as a
 * multipart `file=` part — the server sniffs the bytes for the actual MIME
 * (never trusting `file.type`) and rejects anything that isn't a supported
 * image. Returns the refreshed `CmsCurrentUser` so callers can replace
 * their cached session.
 */
export async function uploadCurrentUserAvatar(
  file: File,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetchImpl(`${basePath}/me/avatar`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const body = await readEnvelope(
    res,
    MeAvatarEnvelope,
    `CMS avatar upload failed with ${res.status}`,
  )
  return body.user
}

/**
 * Clear the current user's avatar. The server keeps the historical media
 * asset (it's a first-class library row); the user falls back to the
 * Gravatar identicon. Returns the refreshed user.
 */
export async function deleteCurrentUserAvatar(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/me/avatar`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    MeAvatarEnvelope,
    `CMS avatar delete failed with ${res.status}`,
  )
  return body.user
}

export async function changeCurrentUserPassword(
  input: { newPassword: string },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/me/password`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(
    res,
    PasswordChangeEnvelope,
    `CMS password change failed with ${res.status}`,
  )
  return body.user
}

export async function startCurrentUserTotpSetup(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ secret: string; otpauthUrl: string }> {
  const res = await fetchImpl(`${basePath}/me/mfa/totp/start`, {
    method: 'POST',
    credentials: 'include',
  })
  return await readEnvelope(
    res,
    TotpStartEnvelope,
    `CMS MFA setup failed with ${res.status}`,
  )
}

export async function enableCurrentUserTotp(
  input: { secret: string; code: string },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ user: CmsCurrentUser; recoveryCodes: string[] }> {
  const res = await fetchImpl(`${basePath}/me/mfa/totp/enable`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(
    res,
    RecoveryCodesEnvelope,
    `CMS MFA enable failed with ${res.status}`,
  )
  return { user: body.user, recoveryCodes: body.recoveryCodes }
}

export async function disableCurrentUserTotp(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/me/mfa/totp`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    MeUserEnvelope,
    `CMS MFA disable failed with ${res.status}`,
  )
  return body.user
}

export async function regenerateCurrentUserRecoveryCodes(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ user: CmsCurrentUser; recoveryCodes: string[] }> {
  const res = await fetchImpl(`${basePath}/me/mfa/recovery-codes`, {
    method: 'POST',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    RecoveryCodesEnvelope,
    `CMS recovery code regeneration failed with ${res.status}`,
  )
  return { user: body.user, recoveryCodes: body.recoveryCodes }
}

export async function updateCurrentUserStepUpSettings(
  input: CmsStepUpSettingsInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/me/security/step-up`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(
    res,
    MeUserEnvelope,
    `CMS step-up settings update failed with ${res.status}`,
  )
  return body.user
}

// ─── Sessions (Account → Sessions tab) ───────────────────────────────────────

const CmsSessionSchema = Type.Object({
  id: Type.String(),
  deviceLabel: Type.String(),
  ipAddress: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  expiresAt: Type.String(),
  isCurrent: Type.Boolean(),
  mfaPassedAt: Type.Union([Type.String(), Type.Null()]),
  stepUpExpiresAt: Type.Union([Type.String(), Type.Null()]),
})

const CmsSessionsEnvelope = Type.Object({
  sessions: Type.Array(CmsSessionSchema),
})

const CmsLogoutAllEnvelope = Type.Object({
  ok: Type.Boolean(),
  revokedCount: Type.Number(),
})

export type CmsSession = Static<typeof CmsSessionSchema>

/**
 * List the current user's live sessions. Drives the Account → Sessions tab.
 * The session whose `isCurrent` flag is `true` is the one this browser is
 * authenticated as.
 */
export async function listCmsSessions(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsSession[]> {
  const res = await fetchImpl(`${basePath}/auth/sessions`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, CmsSessionsEnvelope, `CMS sessions failed with ${res.status}`)
  return body.sessions
}

/**
 * Revoke a single non-current session by its hash. The server enforces the
 * cross-user guard — passing another user's session id returns 404.
 */
export async function revokeCmsSession(
  sessionId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS revoke session failed with ${res.status}`)
}

// ─── Step-up auth ────────────────────────────────────────────────────────────

const CmsStepUpResponseSchema = Type.Object({
  ok: Type.Boolean(),
  stepUpExpiresAt: Type.String(),
  user: Type.Optional(CmsCurrentUserSchema),
}, { additionalProperties: true })

/**
 * Re-authenticate the current session by re-entering the user's password,
 * plus a second-factor code when MFA is enabled.
 * On success, sensitive endpoints (delete user, revoke device, sign out
 * all devices) accept actions until the user's configured window expires.
 *
 * The handler treats a 401 response as a retryable re-authentication error —
 * the calling UI should re-prompt, not redirect to the login form.
 */
export async function stepUpCms(
  input: CmsStepUpInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ stepUpExpiresAt: string; user?: CmsCurrentUser }> {
  const res = await fetchImpl(`${basePath}/auth/step-up`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(
    res,
    CmsStepUpResponseSchema,
    `CMS step-up failed with ${res.status}`,
  )
  return {
    stepUpExpiresAt: body.stepUpExpiresAt,
    user: body.user,
  }
}

/**
 * True when an error coming out of a CMS API call indicates the server
 * rejected the action because the session has no fresh step-up window.
 *
 * The wire format is `{ error: 'step_up_required' }` with HTTP 401. The
 * persistence helpers throw via `assertOk` / `readEnvelope` with the body's
 * `error` string, so the message is what we match against here.
 */
export function isStepUpRequiredError(err: unknown): boolean {
  return err instanceof Error && err.message === 'step_up_required'
}

// ─── Login activity (Account → Activity tab) ─────────────────────────────────

const CmsLoginActivityResultSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('bad_password'),
  Type.Literal('no_user'),
  Type.Literal('account_disabled'),
  Type.Literal('locked'),
  Type.Literal('rate_limited'),
  Type.Literal('mfa_failed'),
])

const CmsLoginActivityEventSchema = Type.Object({
  id: Type.String(),
  attemptedAt: Type.String(),
  emailNorm: Type.Union([Type.String(), Type.Null()]),
  ipAddress: Type.Union([Type.String(), Type.Null()]),
  // Server-derived "Browser on Platform" label. Empty string when the row
  // had no User-Agent (e.g. pre-013 rows recorded before the column existed,
  // or non-browser clients that omitted the header).
  deviceLabel: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  result: CmsLoginActivityResultSchema,
})

const CmsLoginActivityEnvelope = Type.Object({
  events: Type.Array(CmsLoginActivityEventSchema),
})

export type CmsLoginActivityEvent = Static<typeof CmsLoginActivityEventSchema>
export type CmsLoginActivityResult = Static<typeof CmsLoginActivityResultSchema>

/**
 * Login activity feed for the current user. Returned newest first. Combines
 * post-lookup attempts (`user_id` matches) with pre-lookup IP attempts that
 * mention the user's email — so the user sees "someone tried my email from a
 * new IP" alongside their own successful sessions.
 */
export async function listCmsLoginActivity(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsLoginActivityEvent[]> {
  const res = await fetchImpl(`${basePath}/auth/activity`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    CmsLoginActivityEnvelope,
    `CMS login activity failed with ${res.status}`,
  )
  return body.events
}

/**
 * Sign out every other device for the current user. The current cookie is
 * intentionally preserved by the server so the user issuing the action stays
 * signed in. Returns the number of sessions actually revoked.
 */
export async function logoutAllOtherCmsSessions(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<number> {
  const res = await fetchImpl(`${basePath}/auth/logout-all`, {
    method: 'POST',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    CmsLogoutAllEnvelope,
    `CMS logout-all failed with ${res.status}`,
  )
  return body.revokedCount
}
