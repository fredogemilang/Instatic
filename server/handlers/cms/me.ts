/**
 * Self-targeted user mutations — endpoints any authenticated user can call
 * to change their own profile data without needing `users.manage`.
 *
 *   POST   /admin/api/cms/me/avatar — upload a new avatar image
 *   DELETE /admin/api/cms/me/avatar — clear the avatar, falling back to the
 *                                     Gravatar identicon served by the client
 *
 * `GET /admin/api/cms/me` lives in `./auth.ts` because it shares the session
 * helpers with login/logout. The avatar endpoints land here so the file
 * stays focused on self-mutation flows (display-name edit, avatar, future
 * password change all slot in next to each other).
 *
 * Avatars are stored as ordinary `media_assets` rows + an `avatar_media_id`
 * pointer on the user. We deliberately leave the old media row in the
 * library when the user replaces or clears their avatar — the bytes already
 * cost storage and tracking ownership-for-cascade-delete is out of scope
 * for this surface. Operators can prune via the media library.
 */
import type { DbClient } from '../../db/client'
import { getSessionHash, requireAuthenticatedUser, requireStepUp } from '../../auth/authz'
import { hashPassword, verifyPassword } from '../../auth/tokens'
import { markSessionMfaPassed } from '../../auth/sessions'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpProvisioningUri,
  verifyTotpCode,
} from '../../auth/mfa'
import {
  disableUserTotpMfa,
  enableUserTotpMfa,
  replaceUserRecoveryCodeHashes,
  setUserAvatarMediaId,
  updateUserPasswordHash,
} from '../../repositories/users'
import { revokeAllOtherSessions } from '../../repositories/sessions'
import { createAuditEvent } from '../../repositories/audit'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import {
  CMS_API_PREFIX,
  requestAuditContext,
  type CmsHandlerOptions,
} from './shared'
import {
  IMAGE_MIMES,
  acceptUploadedMedia,
  readUploadedFile,
} from './mediaUpload'
import { Type } from '@core/utils/typeboxHelpers'

/**
 * Avatars are capped at 5 MB — full-resolution camera output is wildly
 * oversized for a 96×96 portrait and the library cap (50 MB) is a footgun
 * here. 5 MB still comfortably accommodates a 4000×4000 PNG.
 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

const ChangePasswordBodySchema = Type.Object({
  newPassword: Type.String({ minLength: 12 }),
})

const EnableTotpBodySchema = Type.Object({
  secret: Type.String({ minLength: 16 }),
  code: Type.String({ minLength: 6 }),
})

function newRecoveryCodeSet(): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes()
  return {
    codes,
    hashes: codes.map(hashRecoveryCode),
  }
}

export async function handleMeRoutes(
  req: Request,
  db: DbClient,
  _options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/me/password`) {
    if (req.method !== 'PATCH') return methodNotAllowed()
    const user = await requireStepUp(req, db)
    if (user instanceof Response) return user
    const body = await readValidatedBody(req, ChangePasswordBodySchema)
    if (!body) return badRequest('Password must be at least 12 characters')
    if (await verifyPassword(body.newPassword, user.passwordHash)) {
      return badRequest('Choose a different password')
    }

    const updated = await updateUserPasswordHash(db, user.id, await hashPassword(body.newPassword))
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    const currentSessionHash = await getSessionHash(req)
    const revokedSessions = await revokeAllOtherSessions(db, user.id, currentSessionHash)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { passwordChanged: true, revokedSessions },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, revokedSessions })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp/start`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireStepUp(req, db)
    if (user instanceof Response) return user
    const secret = generateTotpSecret()
    return jsonResponse({
      secret,
      otpauthUrl: totpProvisioningUri({
        issuer: 'Page Builder CMS',
        accountName: user.email,
        secret,
      }),
    })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp/enable`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireStepUp(req, db)
    if (user instanceof Response) return user
    const body = await readValidatedBody(req, EnableTotpBodySchema)
    if (!body) return badRequest('Invalid MFA setup request')

    const codeOk = (() => {
      try {
        return verifyTotpCode(body.secret, body.code)
      } catch {
        return false
      }
    })()
    if (!codeOk) return badRequest('Invalid authentication code')

    const recovery = newRecoveryCodeSet()
    const updated = await enableUserTotpMfa(db, user.id, {
      secret: body.secret,
      recoveryCodeHashes: recovery.hashes,
    })
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })

    const currentSessionHash = await getSessionHash(req)
    if (currentSessionHash) await markSessionMfaPassed(db, currentSessionHash)
    await revokeAllOtherSessions(db, user.id, currentSessionHash)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { mfaEnabled: true, recoveryCodesRegenerated: true },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, recoveryCodes: recovery.codes })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/totp`) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    const user = await requireStepUp(req, db)
    if (user instanceof Response) return user
    const updated = await disableUserTotpMfa(db, user.id)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { mfaEnabled: false },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated })
  }

  if (url.pathname === `${CMS_API_PREFIX}/me/mfa/recovery-codes`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireStepUp(req, db)
    if (user instanceof Response) return user
    if (!user.mfaEnabled) return badRequest('Enable MFA before generating recovery codes')
    const recovery = newRecoveryCodeSet()
    const updated = await replaceUserRecoveryCodeHashes(db, user.id, recovery.hashes)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { recoveryCodesRegenerated: true },
      ...requestAuditContext(req),
    })
    return jsonResponse({ user: updated, recoveryCodes: recovery.codes })
  }

  if (url.pathname !== `${CMS_API_PREFIX}/me/avatar`) return null

  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user

  if (req.method === 'POST') {
    const file = await readUploadedFile(req)
    if (!file) return badRequest('Missing file')

    const asset = await acceptUploadedMedia(db, {
      file,
      maxBytes: MAX_AVATAR_BYTES,
      allowedMimes: IMAGE_MIMES,
      role: 'avatar',
      uploadedByUserId: user.id,
      oversizedMessage: 'Avatar must be smaller than 5 MB',
      unsupportedMessage: 'Avatars must be a JPEG, PNG, GIF, or WebP image',
    })
    if (asset instanceof Response) return asset

    const updated = await setUserAvatarMediaId(db, user.id, asset.id)
    if (!updated) {
      // The user row vanished between auth and the update (e.g. concurrent
      // soft-delete). The uploaded asset stays in the media library — it's
      // already a first-class row and the caller can clean it up there.
      return jsonResponse({ error: 'User not found' }, { status: 404 })
    }

    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { avatarMediaId: asset.id },
      ...requestAuditContext(req),
    })

    return jsonResponse({ user: updated })
  }

  if (req.method === 'DELETE') {
    const updated = await setUserAvatarMediaId(db, user.id, null)
    if (!updated) return jsonResponse({ error: 'User not found' }, { status: 404 })

    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      metadata: { avatarMediaId: null },
      ...requestAuditContext(req),
    })

    return jsonResponse({ user: updated })
  }

  return methodNotAllowed()
}
