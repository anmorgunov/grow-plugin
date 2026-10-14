#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request, GrowError } from './client.mjs'
import { loadCredential, storeCredential, forgetCredential } from './credentials.mjs'
import { recordCommand } from './journal.mjs'
import { readConnectionSelection, resolveConnection, saveConnectionSelection } from './connections.mjs'

const usage =
    'grow.mjs setup|select|forget|capabilities|describe OP|read OP|command OP [--connection local|production] [--port PORT] [--input FILE|-] [--mutation-id ID]'

async function inputJson(filename) {
    const stream = filename === '-' ? process.stdin : createReadStream(filename, { highWaterMark: 65536 })
    const chunks = []
    let bytes = 0
    for await (const chunk of stream) {
        bytes += chunk.length
        if (bytes > 65536) throw new Error('Input exceeds 64 KiB.')
        chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const value = JSON.parse(text)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Input must be a JSON object.')
    return value
}

export async function runCli(
    args,
    services = { home: homedir(), loadCredential, storeCredential, forgetCredential, request }
) {
    args = [...args]
    const command = args.shift()
    if (!command || command === '--help') {
        console.log(usage)
        return
    }
    if (!['setup', 'select', 'forget', 'capabilities', 'describe', 'read', 'command'].includes(command))
        throw new Error(usage)
    const operation = ['describe', 'read', 'command'].includes(command) ? args.shift() : undefined
    const options = {}
    while (args.length) {
        const flag = args.shift()
        if (
            !['--connection', '--port', '--input', '--mutation-id'].includes(flag) ||
            !args.length ||
            options[flag] !== undefined
        )
            throw new Error(usage)
        options[flag] = args.shift()
    }
    if (['setup', 'select'].includes(command) && !options['--connection'])
        throw new Error('Setup and selection require an explicit --connection local or production.')
    const selection = await readConnectionSelection(services.home)
    const { alias, port, origin } = resolveConnection(
        {
            alias: options['--connection'],
            port: options['--port'] === undefined ? undefined : Number(options['--port']),
        },
        selection
    )
    if (command === 'setup') {
        services.storeCredential(origin)
        await saveConnectionSelection({ alias, port, origin }, services.home)
        console.log(JSON.stringify({ configured: alias, origin }))
        return
    }
    if (command === 'forget') {
        services.forgetCredential(origin)
        console.log(JSON.stringify({ removed: alias }))
        return
    }
    const token = services.loadCredential(origin)
    if (command === 'select') {
        await services.request({ alias, port, token, path: 'capabilities' })
        await saveConnectionSelection({ alias, port, origin }, services.home)
        console.log(JSON.stringify({ selected: alias, origin }))
        return
    }
    if (command === 'describe') {
        const capabilities = await services.request({ alias, port, token, path: 'capabilities' })
        const descriptor = capabilities.operations?.find((item) => item.name === operation)
        if (!descriptor) throw new Error('Operation unavailable. Check connection capabilities.')
        console.log(JSON.stringify(descriptor))
        return
    }
    let body
    let mutationId
    if (operation) {
        if (!/^[a-z]+\.[a-z_]+$/.test(operation))
            throw new Error('An operation name is required. Discover names with capabilities.')
        body = { operation, input: options['--input'] ? await inputJson(options['--input']) : {} }
    } else if (command !== 'capabilities') throw new Error('An operation name is required.')
    if (command === 'command') {
        mutationId = options['--mutation-id'] ?? randomUUID()
        body = { mutationId, ...body }
        await recordCommand(join(services.home, '.local', 'share', 'grow-planning', 'commands'), origin, body)
        console.error(
            JSON.stringify({
                mutationId,
                recovery: 'Repeat with this mutation ID and the identical input if the outcome is uncertain.',
            })
        )
    } else if (options['--mutation-id']) throw new Error('Mutation IDs apply only to commands.')
    try {
        const result = await services.request({
            alias,
            port,
            token,
            path: command === 'command' ? 'commands' : command,
            body,
        })
        // Discover names cheaply; describe loads one input schema into the agent context.
        const output =
            command === 'capabilities'
                ? { ...result, operations: result.operations.map(({ name, kind }) => ({ name, kind })) }
                : result
        console.log(JSON.stringify(output))
    } catch (error) {
        if (error instanceof GrowError) error.mutationId = mutationId
        throw error
    }
}

if (
    process.argv[1] &&
    existsSync(process.argv[1]) &&
    fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))
)
    runCli(process.argv.slice(2)).catch((error) => {
        console.error(
            JSON.stringify({
                code: error instanceof GrowError ? error.code : 'CLIENT_ERROR',
                message: error instanceof SyntaxError ? 'Input is not valid JSON.' : error.message,
                ...(error.status ? { status: error.status } : {}),
                ...(error.mutationId ? { mutationId: error.mutationId } : {}),
            })
        )
        process.exitCode = 1
    })
