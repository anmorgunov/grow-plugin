import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])])
        )
    }
    return value
}

export async function recordCommand(directory, origin, body) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(body.mutationId))
        throw new Error('Mutation ID must have 8–128 letters, digits, underscores or hyphens.')
    const digest = createHash('sha256')
        .update(JSON.stringify(canonical({ origin, ...body })))
        .digest('hex')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filename = join(directory, `${body.mutationId}.json`)
    let file
    try {
        file = await open(filename, 'wx', 0o600)
    } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const prior = JSON.parse(await readFile(filename, 'utf8'))
        if (prior.digest !== digest)
            throw new Error('Mutation ID already belongs to a different connection, operation or input.')
        return
    }
    try {
        await file.writeFile(JSON.stringify({ mutationId: body.mutationId, digest }))
        await file.sync()
    } finally {
        await file.close()
    }
    // Persist the directory entry before a request can commit remotely.
    const folder = await open(directory, 'r')
    try {
        await folder.sync()
    } finally {
        await folder.close()
    }
}
