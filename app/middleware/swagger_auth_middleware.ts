import { HttpContext } from '@adonisjs/core/http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import env from '#start/env'

function verifySignedCookie(value: string): boolean {
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return false

  const expected = createHmac('sha256', env.get('APP_KEY')).update(payload).digest('hex')
  const expectedBuf = Buffer.from(expected)
  const signatureBuf = Buffer.from(signature)

  if (expectedBuf.length !== signatureBuf.length) return false
  return timingSafeEqual(expectedBuf, signatureBuf)
}

export default class SwaggerAuthMiddleware {
  async handle({ request, response }: HttpContext, next: () => Promise<void>) {
    const authCookie = request.cookie('swagger_auth')

    if (authCookie && verifySignedCookie(authCookie)) {
      await next()
    } else {
      response.redirect('/hyperflow/login')
    }
  }
}
