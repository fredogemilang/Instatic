import { parseJsonResponse } from '@core/utils/jsonValidate'
import { ErrorEnvelopeSchema } from './responseSchemas'

export async function responseErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = await parseJsonResponse(res.clone(), ErrorEnvelopeSchema)
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Fall through to text response parsing.
  }

  try {
    const text = await res.text()
    if (text.trim()) return text.trim()
  } catch {
    // Fall through to fallback.
  }

  return fallback
}
