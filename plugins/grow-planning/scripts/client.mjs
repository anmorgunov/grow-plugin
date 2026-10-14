import { connectionOrigin } from './credentials.mjs'
import plugin from '../plugin.json' with { type: 'json' }

export class GrowError extends Error {
    constructor(code, message, status = null) {
        super(message)
        this.code = code
        this.status = status
    }
}

export async function request({ alias, port = 3000, token, path, body, timeoutMs = 15000, maxBytes = 1048576 }) {
    const origin = connectionOrigin(alias, port)
    if (!['capabilities', 'read', 'commands'].includes(path)) throw new Error('Unsupported API path.')
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    if (serialized && Buffer.byteLength(serialized) > 65536)
        throw new GrowError('REQUEST_TOO_LARGE', 'Input exceeds 64 KiB.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(`${origin}/api/agent/v1/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json',
                'X-Grow-Plugin-Version': plugin.version,
            },
            body: serialized,
            redirect: 'manual',
            signal: controller.signal,
        })
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel()
            throw new GrowError(
                'REDIRECT_REFUSED',
                'Grow returned a redirect. No credential was forwarded.',
                response.status
            )
        }
        const reader = response.body?.getReader()
        let bytes = 0
        const chunks = []
        if (reader) {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                bytes += value.byteLength
                if (bytes > maxBytes) {
                    await reader.cancel()
                    throw new GrowError('RESPONSE_TOO_LARGE', 'Grow response exceeded the client limit.')
                }
                chunks.push(Buffer.from(value))
            }
        }
        let result
        try {
            result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            throw new GrowError('INVALID_RESPONSE', 'Grow returned an invalid JSON response.', response.status)
        }
        if (!response.ok) {
            // Do not echo server messages: proxy failures can contain headers or other secrets.
            const code =
                typeof result?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(result.code)
                    ? result.code
                    : 'HTTP_ERROR'
            throw new GrowError(code, `Grow rejected the request (HTTP ${response.status}).`, response.status)
        }
        return result
    } catch (error) {
        if (error instanceof GrowError) throw error
        throw new GrowError(
            controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
            'No confirmed response. Recover writes using the original mutation ID and input.'
        )
    } finally {
        clearTimeout(timeout)
    }
}
