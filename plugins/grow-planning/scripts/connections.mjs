import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectionOrigin } from './credentials.mjs'

const metadataError = () =>
    new Error(
        'Saved connection metadata is invalid or unsafe. Remove connection.json and select the intended connection again.'
    )

function validateDirectory(info) {
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw metadataError()
}

async function connectionDirectory(home, create = false) {
    validateDirectory(await lstat(home))
    let directory = home
    for (const segment of ['.local', 'share', 'grow-planning']) {
        directory = join(directory, segment)
        if (create) {
            try {
                await mkdir(directory, { mode: 0o700 })
            } catch (error) {
                if (error.code !== 'EEXIST') throw error
            }
        }
        let info
        try {
            info = await lstat(directory)
        } catch (error) {
            if (!create && error.code === 'ENOENT') return null
            throw error
        }
        validateDirectory(info)
        if (segment === 'grow-planning' && (info.mode & 0o077) !== 0) throw metadataError()
    }
    return directory
}

function validateMetadataFile(info) {
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
        throw metadataError()
}

function parseSelection(text) {
    let value
    try {
        value = JSON.parse(text)
    } catch {
        throw metadataError()
    }
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'localPort,selectedConnection,version' ||
        value.version !== 1 ||
        !['local', 'production'].includes(value.selectedConnection)
    )
        throw metadataError()
    try {
        connectionOrigin('local', value.localPort)
    } catch {
        throw metadataError()
    }
    return value
}

export async function readConnectionSelection(home = homedir()) {
    const directory = await connectionDirectory(home)
    if (!directory) return null
    const filename = join(directory, 'connection.json')
    let info
    try {
        info = await lstat(filename)
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw metadataError()
    }
    validateMetadataFile(info)
    let file
    try {
        file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = await file.stat()
        validateMetadataFile(opened)
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > 4096) throw metadataError()
        const buffer = Buffer.alloc(4097)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead !== opened.size) throw metadataError()
        return parseSelection(buffer.subarray(0, bytesRead).toString('utf8'))
    } catch {
        throw metadataError()
    } finally {
        await file?.close()
    }
}

export function resolveConnection({ alias, port }, selection) {
    const selectedAlias = alias ?? selection?.selectedConnection
    if (!selectedAlias)
        throw new Error('No connection selected. Select an existing Keychain connection or run human setup.')
    if (selectedAlias === 'production' && port !== undefined)
        throw new Error('Production does not accept a port override.')
    const selectedPort = selectedAlias === 'local' ? (port ?? selection?.localPort ?? 3000) : undefined
    const origin = connectionOrigin(selectedAlias, selectedPort)
    return { alias: selectedAlias, port: selectedPort, origin }
}

export async function saveConnectionSelection(connection, home = homedir()) {
    const previous = await readConnectionSelection(home)
    const origin = resolveConnection(connection, previous).origin
    if (origin !== connection.origin) throw new Error('Connection origin does not match its selection.')
    const selection = {
        version: 1,
        selectedConnection: connection.alias,
        localPort: connection.alias === 'local' ? connection.port : (previous?.localPort ?? 3000),
    }
    parseSelection(JSON.stringify(selection))
    const directory = await connectionDirectory(home, true)
    const filename = join(directory, 'connection.json')
    const temporary = join(directory, `.connection-${randomUUID()}.tmp`)
    let file
    try {
        file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
        )
        await file.writeFile(JSON.stringify(selection) + '\n')
        await file.sync()
        await file.close()
        file = undefined
        await rename(temporary, filename)
        const folder = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
            await folder.sync()
        } finally {
            await folder.close()
        }
    } finally {
        await file?.close()
        await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT') throw error
        })
    }
}
