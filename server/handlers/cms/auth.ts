/**
 * Authentication endpoints — login, MFA, session lifecycle, step-up.
 *
 *   POST   /admin/api/cms/login              — exchange (email, password) for a session
 *                                              cookie, after rate-limit + constant-time
 *                                              password verification.
 *   POST   /admin/api/cms/auth/mfa/verify    — complete the second factor for a pending
 *                                              session minted by /login.
 *   POST   /admin/api/cms/logout             — revoke the current session row + clear
 *                                              the cookie.
 *   GET    /admin/api/cms/me                 — return the authenticated user, role, and
 *                                              capabilities (used by the admin shell).
 *   GET    /admin/api/cms/auth/sessions      — list this user's live sessions.
 *   DELETE /admin/api/cms/auth/sessions/:id  — revoke one of this user's sessions.
 *   POST   /admin/api/cms/auth/step-up       — open a 15-minute step-up window.
 *   GET    /admin/api/cms/auth/activity      — login attempts for this user.
 *   POST   /admin/api/cms/auth/logout-all    — revoke every other session for this user.
 *
 * Dispatch shape: a small route table maps `(method, pattern)` to a per-route
 * async handler. The dispatcher itself is a 15-line loop — adding a new auth
 * endpoint is "new handler function + one row in `AUTH_ROUTES`", not "edit a
 * giant if/else chain". Parameterised paths (currently only the session
 * revoke route) use a `RegExp` pattern with a named capture group.
 */
import type { DbClient } from '../../db/client'
import {
  createSessionToken,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from '../../auth/tokens'
import {
  createSession,
  findUserByPendingMfaSessionHash,
  rotateSessionToken,
  revokeSessionByHash,
} from '../../auth/sessions'
import {
  listSessionsForUser,
  revokeAllOtherSessions,
  revokeSessionByHashForUser,
} from '../../repositories/sessions'
import {
  findUserById,
  findUserByEmail,
  markUserLoggedIn,
  recordFailedLoginAttempt,
  consumeUserRecoveryCodeHash,
  toPublicUser,
  type AuthUser,
} from '../../repositories/users'
import {
  requireAuthenticatedUser,
  requireStepUp,
  getSessionHash,
  STEP_UP_WINDOW_MS,
} from '../../auth/authz'
import { createAuditEvent } from '../../repositories/audit'
import {
  listLoginActivityForUser,
  recordLoginAttempt,
  type LoginAttemptResult,
} from '../../repositories/loginAttempts'
import { loginPerIpRateLimit, loginRateLimit, mfaRateLimit } from '../../auth/rateLimit'
import { evaluateFailedAttempt, evaluateLockState } from '../../auth/lockout'
import { clientIp } from '../../auth/security'
import { deriveDeviceLabel } from '../../auth/deviceLabel'
import { findMatchingRecoveryCodeHash, verifyTotpCode } from '../../auth/mfa'
import { jsonResponse, methodNotAllowed, readValidatedBody, setCookieHeader } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { clearSessionCookie, getDummyPasswordHash, sessionCookie } from './session'

type RouteParams = Record<string, string>
type AuthHandler = (req: Request, db: DbClient, params: RouteParams) => Promise<Response>

interface AuthRoute {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly pattern: string | RegExp
  readonly handler: AuthHandler
}

/**
 * Helper: build a 429 response with a `Retry-After` header. Centralises the
 * `Math.ceil(ms / 1000)` rounding so we don't sprinkle that arithmetic in
 * every rate-limit branch.
 */
function rateLimitedResponse(message: string, retryAfterMs: number): Response {
  return jsonResponse(
    { error: message },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
    },
  )
}

function accountLockedResponse(retryAfterMs: number): Response {
  return jsonResponse(
    { error: 'Account locked. Try again later.' },
    {
      status: 423,
      headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
    },
  )
}

/**
 * True when the user row carried any prior lockout signal — either an active
 * `locked_until` timestamp (we already let the legitimate user through after
 * the window elapsed but before a successful login cleared the column) or a
 * non-zero failed-login counter. Drives the `login.unlocked` audit event so
 * operators see when an account recovers from a lock.
 */
function previouslyLocked(user: AuthUser): boolean {
  if (user.failedLoginCount > 0) return true
  return user.lockedUntil !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Layer 1 — per-IP rate limit. Blanket protection so a single attacker IP
 * cannot grind through many target accounts. Skipped when no IP is surfaced
 * (Bun.serve without a proxy in front); the per-(ip, email) tuple limiter
 * still applies.
 */
async function enforceLoginIpRateLimit(
  db: DbClient,
  req: Request,
  email: string,
  ip: string | null,
): Promise<Response | null> {
  if (!ip) return null
  const decision = loginPerIpRateLimit.consume(ip)
  if (decision.ok) return null
  await recordLoginAttempt(db, {
    emailNorm: email || null,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: null,
    result: 'rate_limited',
  })
  await createAuditEvent(db, {
    actorUserId: null,
    action: 'login.rate_limited',
    targetType: 'user',
    targetId: null,
    metadata: { email, scope: 'ip' },
    ...requestAuditContext(req),
  })
  return rateLimitedResponse(
    'Too many login attempts from this address. Try again later.',
    decision.retryAfterMs,
  )
}

/**
 * Layer 2 — per-(IP, email) tuple. Defends a single account across many
 * attacker IPs that haven't individually hit the per-IP cap. Consumed BEFORE
 * any DB lookup or password verification — an attacker who triggers the 429
 * cannot make us burn argon2id CPU cycles.
 */
async function enforceLoginTupleRateLimit(
  db: DbClient,
  req: Request,
  email: string,
  ip: string | null,
  rateLimitKey: string,
): Promise<Response | null> {
  const decision = loginRateLimit.consume(rateLimitKey)
  if (decision.ok) return null
  await recordLoginAttempt(db, {
    emailNorm: email || null,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: null,
    result: 'rate_limited',
  })
  await createAuditEvent(db, {
    actorUserId: null,
    action: 'login.rate_limited',
    targetType: 'user',
    targetId: null,
    metadata: { email, scope: 'tuple' },
    ...requestAuditContext(req),
  })
  return rateLimitedResponse('Too many login attempts. Try again later.', decision.retryAfterMs)
}

/**
 * Failure path: account exists but is locked. Records the attempt, emits a
 * `login.failure` audit event with `locked: true`, and returns 423 with a
 * `Retry-After` header derived from `locked_until`.
 */
async function respondLoginAccountLocked(
  db: DbClient,
  req: Request,
  user: AuthUser,
  email: string,
  ip: string | null,
  retryAfterMs: number,
): Promise<Response> {
  await recordLoginAttempt(db, {
    emailNorm: email || null,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user.id,
    result: 'locked',
  })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'login.failure',
    targetType: 'user',
    targetId: user.id,
    metadata: { email, locked: true, lockedUntil: user.lockedUntil ?? '' },
    ...requestAuditContext(req),
  })
  return accountLockedResponse(retryAfterMs)
}

/**
 * Failure path: no-user / disabled / wrong-password. Records the attempt,
 * bumps the per-account counter on the bad-password-against-active branch
 * only, emits the audit trail, and returns either 423 (lockout just
 * triggered) or 401 (generic failure).
 */
async function respondLoginFailure(
  db: DbClient,
  req: Request,
  user: AuthUser | null,
  email: string,
  ip: string | null,
): Promise<Response> {
  const failureReason: LoginAttemptResult = !user
    ? 'no_user'
    : user.status !== 'active'
      ? 'account_disabled'
      : 'bad_password'

  await recordLoginAttempt(db, {
    emailNorm: email || null,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user?.id ?? null,
    result: failureReason,
  })

  // Bump the per-account counter ONLY for the bad-password-against-active
  // branch. A "no such user" attempt is bound to the IP layer and the
  // login_attempts log; we don't speculatively penalise an account that
  // doesn't exist. A suspended/disabled account doesn't need its counter
  // raised either — the operator already gated it.
  let lockedUntilIso: string | null = null
  if (user && user.status === 'active' && failureReason === 'bad_password') {
    const lockout = evaluateFailedAttempt(user.failedLoginCount)
    await recordFailedLoginAttempt(db, user.id, lockout.lockedUntil)
    if (lockout.triggered && lockout.lockedUntil) {
      lockedUntilIso = lockout.lockedUntil.toISOString()
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'login.locked',
        targetType: 'user',
        targetId: user.id,
        metadata: {
          email,
          lockedUntil: lockedUntilIso,
          failedLoginCount: lockout.failedLoginCount,
        },
        ...requestAuditContext(req),
      })
    }
  }

  await createAuditEvent(db, {
    actorUserId: user?.id ?? null,
    action: 'login.failure',
    targetType: 'user',
    targetId: user?.id ?? null,
    metadata: { email, reason: failureReason },
    ...requestAuditContext(req),
  })

  if (lockedUntilIso) {
    const retryAfterMs = Math.max(0, Date.parse(lockedUntilIso) - Date.now())
    return accountLockedResponse(retryAfterMs)
  }
  return jsonResponse({ error: 'Invalid email or password' }, { status: 401 })
}

/**
 * Success path: mints a session row, returns the session cookie. When MFA is
 * enabled the session is created with `mfaPassedAt: null` and the response
 * carries `mfaRequired: true` — the client then follows up with
 * `POST /auth/mfa/verify`. Without MFA the session is immediately valid.
 */
async function respondLoginSuccess(
  db: DbClient,
  req: Request,
  user: AuthUser,
  email: string,
  ip: string | null,
  rateLimitKey: string,
): Promise<Response> {
  // Successful login → release this user's bucket so a forgotten password
  // followed by a correct attempt doesn't continue eating into the quota.
  loginRateLimit.reset(rateLimitKey)

  const wasPreviouslyLocked = previouslyLocked(user)

  const token = createSessionToken()
  const expiresAt = sessionExpiry()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: user.id,
    expiresAt,
    mfaPassedAt: user.mfaEnabled ? null : new Date(),
    ...requestAuditContext(req),
  })

  if (user.mfaEnabled) {
    return setCookieHeader(
      jsonResponse({ ok: true, mfaRequired: true }),
      sessionCookie(req, token, expiresAt),
    )
  }

  await recordLoginAttempt(db, {
    emailNorm: email || null,
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user.id,
    result: 'success',
  })
  await markUserLoggedIn(db, user.id)

  if (wasPreviouslyLocked) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'login.unlocked',
      targetType: 'user',
      targetId: user.id,
      metadata: { email },
      ...requestAuditContext(req),
    })
  }

  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'login.success',
    targetType: 'user',
    targetId: user.id,
    metadata: {},
    ...requestAuditContext(req),
  })

  return setCookieHeader(
    jsonResponse({ ok: true, mfaRequired: false }),
    sessionCookie(req, token, expiresAt),
  )
}

const LoginBodySchema = Type.Object({ email: Type.String(), password: Type.String() })

async function handleLogin(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, LoginBodySchema)
  const email = (body?.email ?? '').trim().toLowerCase()
  const password = (body?.password ?? '').trim()
  const ip = clientIp(req)

  const ipBlock = await enforceLoginIpRateLimit(db, req, email, ip)
  if (ipBlock) return ipBlock

  const rateLimitKey = `${ip ?? 'unknown'}|${email}`
  const tupleBlock = await enforceLoginTupleRateLimit(db, req, email, ip, rateLimitKey)
  if (tupleBlock) return tupleBlock

  // Constant-time path: ALWAYS run argon2id verify, even when the email
  // doesn't match a user. Without this, "user not found" returns in ~5ms
  // while "user found, wrong password" takes ~100ms — a timing oracle for
  // email enumeration. We verify against a fixed dummy hash on the no-user
  // branch; the result is always false, but the latency profile is the
  // same as the real branch.
  const user = await findUserByEmail(db, email)
  const verifiedHash = user?.passwordHash ?? (await getDummyPasswordHash())
  const passwordOk = await verifyPassword(password, verifiedHash)

  // Layer 3 — per-account lockout. Checked AFTER constant-time password
  // verify so the locked-vs-not-locked latency profile doesn't leak whether
  // the email exists.
  if (user) {
    const lockState = evaluateLockState(user.lockedUntil)
    if (lockState.locked) {
      return respondLoginAccountLocked(db, req, user, email, ip, lockState.retryAfterMs)
    }
  }

  if (!user || user.status !== 'active' || !passwordOk) {
    return respondLoginFailure(db, req, user, email, ip)
  }

  return respondLoginSuccess(db, req, user, email, ip, rateLimitKey)
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/mfa/verify
// ─────────────────────────────────────────────────────────────────────────────

async function handleMfaVerify(req: Request, db: DbClient): Promise<Response> {
  const idHash = await getSessionHash(req)
  if (!idHash) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  const user = await findUserByPendingMfaSessionHash(db, idHash)
  if (!user) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })

  const ip = clientIp(req)
  const rateLimitKey = ip ?? 'unknown'
  const decision = mfaRateLimit.consume(rateLimitKey)
  if (!decision.ok) {
    await recordLoginAttempt(db, {
      emailNorm: user.email.toLowerCase(),
      ipAddress: ip,
      userAgent: req.headers.get('user-agent'),
      userId: user.id,
      result: 'rate_limited',
    })
    return rateLimitedResponse('Too many MFA attempts. Try again later.', decision.retryAfterMs)
  }

  const MfaVerifyBodySchema = Type.Object({ code: Type.String() })
  const body = await readValidatedBody(req, MfaVerifyBodySchema)
  const code = body?.code ?? ''
  const totpOk = user.mfaTotpSecret ? verifyTotpCode(user.mfaTotpSecret, code) : false
  const recoveryHash = findMatchingRecoveryCodeHash(code, user.mfaRecoveryCodeHashes)
  if (!totpOk && !recoveryHash) {
    await recordLoginAttempt(db, {
      emailNorm: user.email.toLowerCase(),
      ipAddress: ip,
      userAgent: req.headers.get('user-agent'),
      userId: user.id,
      result: 'mfa_failed',
    })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'login.failure',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'mfa' },
      ...requestAuditContext(req),
    })
    return jsonResponse({ error: 'Invalid authentication code' }, { status: 401 })
  }

  if (recoveryHash) {
    const consumed = await consumeUserRecoveryCodeHash(db, user.id, recoveryHash)
    if (!consumed) return jsonResponse({ error: 'Invalid authentication code' }, { status: 401 })
  }

  const nextToken = createSessionToken()
  const rotatedSession = await rotateSessionToken(db, idHash, {
    nextIdHash: await hashSessionToken(nextToken),
    mfaPassedAt: new Date(),
  })
  if (!rotatedSession) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })

  await markUserLoggedIn(db, user.id)
  await recordLoginAttempt(db, {
    emailNorm: user.email.toLowerCase(),
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user.id,
    result: 'success',
  })
  mfaRateLimit.reset(rateLimitKey)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'login.success',
    targetType: 'user',
    targetId: user.id,
    metadata: { mfa: true, recoveryCodeUsed: Boolean(recoveryHash) },
    ...requestAuditContext(req),
  })
  return setCookieHeader(
    jsonResponse({ ok: true }),
    sessionCookie(req, nextToken, rotatedSession.expiresAt),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /logout, GET /me
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogout(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  const idHash = await getSessionHash(req)
  if (idHash) await revokeSessionByHash(db, idHash)
  if (!(user instanceof Response)) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'logout',
      targetType: 'user',
      targetId: user.id,
      metadata: {},
      ...requestAuditContext(req),
    })
  }
  return setCookieHeader(jsonResponse({ ok: true }), clearSessionCookie(req))
}

async function handleMe(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  return jsonResponse({ user: toPublicUser(user), role: user.role, capabilities: user.capabilities })
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/sessions, DELETE /auth/sessions/:id, POST /auth/logout-all
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/sessions — list this user's live sessions. Drives the Account →
 * Sessions tab. The current session is flagged via `isCurrent: true` so the
 * UI can pin it and disable its "Sign out" action.
 */
async function handleListSessions(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const currentSessionHash = await getSessionHash(req)
  const sessions = await listSessionsForUser(db, user.id, currentSessionHash)
  return jsonResponse({ sessions })
}

/**
 * DELETE /auth/sessions/:id — revoke one of the current user's sessions. The
 * `:id` segment IS the session hash. Cross-user revoke is blocked by the
 * repo's `user_id = $userId` predicate.
 *
 * Revoking the *current* session is rejected with 400 to nudge clients to
 * use the regular `/logout` endpoint, which also clears the cookie. The
 * current cookie would otherwise remain on the client until next request.
 *
 * Step-up gated: the user must have re-entered their password within the
 * last 15 minutes — kicking another device off your account is sensitive
 * enough that we don't want a stolen cookie alone to enable it.
 */
async function handleRevokeSession(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireStepUp(req, db)
  if (user instanceof Response) return user
  const targetHash = params.id
  if (!targetHash) return jsonResponse({ error: 'Invalid session id' }, { status: 400 })
  const currentSessionHash = await getSessionHash(req)
  if (currentSessionHash && currentSessionHash === targetHash) {
    return jsonResponse(
      { error: 'Use POST /logout to sign out the current session.' },
      { status: 400 },
    )
  }
  const revoked = await revokeSessionByHashForUser(db, targetHash, user.id)
  if (!revoked) return jsonResponse({ error: 'Session not found' }, { status: 404 })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'logout',
    targetType: 'user',
    targetId: user.id,
    metadata: { scope: 'device' },
    ...requestAuditContext(req),
  })
  return jsonResponse({ ok: true })
}

/**
 * POST /auth/logout-all — revoke every other live session for the current
 * user. The current cookie is intentionally preserved so the user issuing
 * the action stays signed in. Step-up gated — wholesale device wipe is the
 * highest-blast-radius session action we expose.
 */
async function handleLogoutAll(req: Request, db: DbClient): Promise<Response> {
  const user = await requireStepUp(req, db)
  if (user instanceof Response) return user
  const currentSessionHash = await getSessionHash(req)
  const revokedCount = await revokeAllOtherSessions(db, user.id, currentSessionHash)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'logout',
    targetType: 'user',
    targetId: user.id,
    metadata: { scope: 'all_other_devices', revokedCount },
    ...requestAuditContext(req),
  })
  return jsonResponse({ ok: true, revokedCount })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/step-up
// ─────────────────────────────────────────────────────────────────────────────

async function recordStepUpRateLimit(
  db: DbClient,
  req: Request,
  user: AuthUser,
  ip: string | null,
  scope: 'ip' | 'tuple',
  retryAfterMs: number,
): Promise<Response> {
  await recordLoginAttempt(db, {
    emailNorm: user.email.toLowerCase(),
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user.id,
    result: 'rate_limited',
  })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'login.rate_limited',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: user.email.toLowerCase(), scope: `step_up_${scope}` },
    ...requestAuditContext(req),
  })
  return rateLimitedResponse(
    scope === 'ip'
      ? 'Too many login attempts from this address. Try again later.'
      : 'Too many login attempts. Try again later.',
    retryAfterMs,
  )
}

async function recordStepUpPasswordFailure(
  db: DbClient,
  req: Request,
  user: AuthUser,
  ip: string | null,
): Promise<Response> {
  await recordLoginAttempt(db, {
    emailNorm: user.email.toLowerCase(),
    ipAddress: ip,
    userAgent: req.headers.get('user-agent'),
    userId: user.id,
    result: 'bad_password',
  })

  const lockout = evaluateFailedAttempt(user.failedLoginCount)
  await recordFailedLoginAttempt(db, user.id, lockout.lockedUntil)

  if (lockout.triggered && lockout.lockedUntil) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'login.locked',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        email: user.email.toLowerCase(),
        lockedUntil: lockout.lockedUntil.toISOString(),
        failedLoginCount: lockout.failedLoginCount,
        reason: 'step_up',
      },
      ...requestAuditContext(req),
    })
  }

  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'login.failure',
    targetType: 'user',
    targetId: user.id,
    metadata: { reason: 'step_up' },
    ...requestAuditContext(req),
  })

  if (lockout.triggered && lockout.lockedUntil) {
    const retryAfterMs = Math.max(0, lockout.lockedUntil.getTime() - Date.now())
    return accountLockedResponse(retryAfterMs)
  }

  return jsonResponse({ error: 'Invalid password' }, { status: 401 })
}

/**
 * Step-up MFA check. Mirrors the MFA layer of `/login` but only fires when
 * the user has MFA enabled. Returns either:
 *   - `{ ok: Response }` — the second factor failed; return this to the client.
 *   - `{ ok: null, user: AuthUser }` — MFA passed (`user` may be refreshed if
 *     a recovery code was consumed); continue to mint the step-up window.
 */
async function verifyStepUpMfa(
  db: DbClient,
  req: Request,
  user: AuthUser,
  ip: string | null,
  mfaCode: string,
): Promise<{ failure: Response; user: null } | { failure: null; user: AuthUser }> {
  if (!mfaCode) {
    return {
      failure: jsonResponse({ error: 'Authentication code required' }, { status: 401 }),
      user: null,
    }
  }

  const rateLimitKey = ip ?? 'unknown'
  const mfaDecision = mfaRateLimit.consume(rateLimitKey)
  if (!mfaDecision.ok) {
    await recordLoginAttempt(db, {
      emailNorm: user.email.toLowerCase(),
      ipAddress: ip,
      userAgent: req.headers.get('user-agent'),
      userId: user.id,
      result: 'rate_limited',
    })
    return {
      failure: rateLimitedResponse(
        'Too many MFA attempts. Try again later.',
        mfaDecision.retryAfterMs,
      ),
      user: null,
    }
  }

  const totpOk = (() => {
    try {
      return user.mfaTotpSecret ? verifyTotpCode(user.mfaTotpSecret, mfaCode) : false
    } catch {
      return false
    }
  })()
  const recoveryHash = findMatchingRecoveryCodeHash(mfaCode, user.mfaRecoveryCodeHashes)
  if (!totpOk && !recoveryHash) {
    await recordLoginAttempt(db, {
      emailNorm: user.email.toLowerCase(),
      ipAddress: ip,
      userAgent: req.headers.get('user-agent'),
      userId: user.id,
      result: 'mfa_failed',
    })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'login.failure',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'step_up_mfa' },
      ...requestAuditContext(req),
    })
    return {
      failure: jsonResponse({ error: 'Invalid authentication code' }, { status: 401 }),
      user: null,
    }
  }

  let refreshedUser = user
  if (recoveryHash) {
    const consumed = await consumeUserRecoveryCodeHash(db, user.id, recoveryHash)
    if (!consumed) {
      return {
        failure: jsonResponse({ error: 'Invalid authentication code' }, { status: 401 }),
        user: null,
      }
    }
    refreshedUser = await findUserById(db, user.id) ?? user
  }

  mfaRateLimit.reset(rateLimitKey)
  return { failure: null, user: refreshedUser }
}

/**
 * POST /auth/step-up — re-authenticate with the current user's password to
 * open a 15-minute step-up window on the active session. Sensitive endpoints
 * (delete user, revoke device, sign out all devices) call `requireStepUp`
 * and return 401 `{ error: 'step_up_required' }` when the window is closed;
 * the client shows a step-up dialog that POSTs here, then retries the
 * original request after a 200.
 *
 * Locked accounts cannot open a step-up window (the lockout policy blocks
 * login too — same threat model). Failed step-up attempts are recorded in
 * `login_attempts` with `result: 'bad_password'` so the forensic trail
 * captures them.
 */
async function handleStepUp(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const idHash = await getSessionHash(req)
  if (!idHash) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })

  // Mirror login's locked-account check so a compromised cookie can't
  // brute-force the password through step-up.
  const lockState = evaluateLockState(user.lockedUntil)
  if (lockState.locked) {
    return accountLockedResponse(lockState.retryAfterMs)
  }

  const ip = clientIp(req)
  if (ip) {
    const ipDecision = loginPerIpRateLimit.consume(ip)
    if (!ipDecision.ok) {
      return recordStepUpRateLimit(db, req, user, ip, 'ip', ipDecision.retryAfterMs)
    }
  }

  const rateLimitKey = `${ip ?? 'unknown'}|${user.email.toLowerCase()}`
  const decision = loginRateLimit.consume(rateLimitKey)
  if (!decision.ok) {
    return recordStepUpRateLimit(db, req, user, ip, 'tuple', decision.retryAfterMs)
  }

  const StepUpBodySchema = Type.Object({ password: Type.String(), mfaCode: Type.Optional(Type.String()) })
  const body = await readValidatedBody(req, StepUpBodySchema)
  const password = (body?.password ?? '').trim()
  const mfaCode = (body?.mfaCode ?? '').trim()
  const passwordOk = await verifyPassword(password, user.passwordHash)
  if (!passwordOk) {
    return recordStepUpPasswordFailure(db, req, user, ip)
  }
  loginRateLimit.reset(rateLimitKey)

  let refreshedUser = user
  if (user.mfaEnabled) {
    const mfaResult = await verifyStepUpMfa(db, req, user, ip, mfaCode)
    if (mfaResult.failure) return mfaResult.failure
    refreshedUser = mfaResult.user
  }

  const expiresAt = new Date(Date.now() + STEP_UP_WINDOW_MS)
  const nextToken = createSessionToken()
  const rotatedSession = await rotateSessionToken(db, idHash, {
    nextIdHash: await hashSessionToken(nextToken),
    stepUpExpiresAt: expiresAt,
  })
  if (!rotatedSession) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })

  return setCookieHeader(
    jsonResponse({
      ok: true,
      stepUpExpiresAt: expiresAt.toISOString(),
      user: toPublicUser(refreshedUser),
    }),
    sessionCookie(req, nextToken, rotatedSession.expiresAt),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/activity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/activity — login activity feed for the current user. Drives the
 * Account → Activity tab. Combines `user_id`-matched rows with pre-lookup
 * IP attempts that mention the user's email.
 *
 * The human-readable device label is derived server-side so the client never
 * ships a UA parser. The raw `userAgent` is omitted from the wire — operators
 * can still consult the raw column directly for forensics.
 */
async function handleActivity(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const attempts = await listLoginActivityForUser(db, user.id, user.email.toLowerCase())
  const events = attempts.map((attempt) => ({
    id: attempt.id,
    attemptedAt: attempt.attemptedAt,
    emailNorm: attempt.emailNorm,
    ipAddress: attempt.ipAddress,
    deviceLabel: deriveDeviceLabel(attempt.userAgent),
    userId: attempt.userId,
    result: attempt.result,
  }))
  return jsonResponse({ events })
}

// ─────────────────────────────────────────────────────────────────────────────
// Route table + dispatcher
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_ROUTES: readonly AuthRoute[] = [
  { method: 'POST', pattern: `${CMS_API_PREFIX}/login`, handler: handleLogin },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/auth/mfa/verify`, handler: handleMfaVerify },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/logout`, handler: handleLogout },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/me`, handler: handleMe },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/sessions`, handler: handleListSessions },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${CMS_API_PREFIX}/auth/sessions/(?<id>[^/]+)$`),
    handler: handleRevokeSession,
  },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/auth/step-up`, handler: handleStepUp },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/activity`, handler: handleActivity },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/auth/logout-all`, handler: handleLogoutAll },
]

function matchRoute(
  pathname: string,
  route: AuthRoute,
): RouteParams | null {
  if (typeof route.pattern === 'string') {
    return pathname === route.pattern ? {} : null
  }
  const match = pathname.match(route.pattern)
  return match ? { ...(match.groups ?? {}) } : null
}

export async function handleAuthRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  for (const route of AUTH_ROUTES) {
    const params = matchRoute(pathname, route)
    if (params === null) continue
    if (req.method !== route.method) return methodNotAllowed()
    return route.handler(req, db, params)
  }
  return null
}
