import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile, chmod, symlink, link, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from '../scripts/client.mjs'
import { recordCommand } from '../scripts/journal.mjs'
import { connectionOrigin } from '../scripts/credentials.mjs'
import { readConnectionSelection, resolveConnection, saveConnectionSelection } from '../scripts/connections.mjs'
import { runCli } from '../scripts/grow.mjs'

async function server(t, handler) {
    const instance = createServer(handler)
    await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
    t.after(() => {
        instance.closeAllConnections()
        instance.close()
    })
    return instance.address().port
}

void test('fixed connection origins reject arbitrary destinations', () => {
    assert.equal(connectionOrigin('production'), 'https://grow.ischemist.com')
    assert.equal(connectionOrigin('local', 4123), 'http://127.0.0.1:4123')
    assert.throws(() => connectionOrigin('https://attacker.invalid'))
    assert.throws(() => connectionOrigin('local', NaN))
})

void test('read sends only the requested contract and authenticated origin', async (t) => {
    const port = await server(t, async (req, res) => {
        assert.equal(req.url, '/api/agent/v1/read')
        assert.equal(req.headers.authorization, 'Bearer fixture-secret')
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { operation: 'tasks.list', input: { limit: 5 } })
        res.end(JSON.stringify({ data: { items: [], nextCursor: null }, revision: '42' }))
    })
    assert.deepEqual(
        await request({
            alias: 'local',
            port,
            token: 'fixture-secret',
            path: 'read',
            body: { operation: 'tasks.list', input: { limit: 5 } },
        }),
        { data: { items: [], nextCursor: null }, revision: '42' }
    )
})

void test('redirect never forwards a credential', async (t) => {
    let leaked = false
    const destination = await server(t, (_req, res) => {
        leaked = true
        res.end('{}')
    })
    const port = await server(t, (_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${destination}/stolen` })
        res.end()
    })
    await assert.rejects(request({ alias: 'local', port, token: 'fixture-secret', path: 'capabilities' }), {
        code: 'REDIRECT_REFUSED',
    })
    assert.equal(leaked, false)
})

void test('timeout includes streamed response body', async (t) => {
    const port = await server(t, (_req, res) => {
        res.writeHead(200)
        res.write('{')
    })
    await assert.rejects(
        request({ alias: 'local', port, token: 'fixture-secret', path: 'capabilities', timeoutMs: 30 }),
        { code: 'TIMEOUT' }
    )
})

void test('oversized and malformed responses are bounded safe failures', async (t) => {
    const port = await server(t, (_req, res) => res.end('x'.repeat(2048)))
    await assert.rejects(
        request({ alias: 'local', port, token: 'fixture-secret', path: 'capabilities', maxBytes: 1024 }),
        { code: 'RESPONSE_TOO_LARGE' }
    )
    await assert.rejects(request({ alias: 'local', port, token: 'fixture-secret', path: 'capabilities' }), {
        code: 'INVALID_RESPONSE',
    })
})

void test('auth failure preserves code without reflecting secret server text', async (t) => {
    const port = await server(t, (_req, res) => {
        res.writeHead(401)
        res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'fixture-secret' }))
    })
    await assert.rejects(
        request({ alias: 'local', port, token: 'fixture-secret', path: 'read', body: {} }),
        (error) => {
            assert.equal(error.code, 'UNAUTHORIZED')
            assert.equal(error.status, 401)
            assert.ok(!error.message.includes('fixture-secret'))
            return true
        }
    )
})

void test('lost response recovery reuses the journaled ID and cannot change input', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'grow-journal-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const body = {
        mutationId: 'test-command-id',
        operation: 'tasks.update',
        input: { id: 'task-a', name: 'Read paper', expectedVersion: '2' },
    }
    let committed = false
    let changes = 0
    const port = await server(t, async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const received = JSON.parse(Buffer.concat(chunks))
        assert.deepEqual(received, body)
        if (!committed) {
            committed = true
            changes++
            req.socket.destroy()
            return
        }
        res.end(
            JSON.stringify({
                data: {},
                receipt: { mutationId: body.mutationId, operation: body.operation, revision: '43' },
                replayed: true,
            })
        )
    })
    const origin = connectionOrigin('local', port)
    await recordCommand(directory, origin, body)
    const call = () => request({ alias: 'local', port, token: 'fixture-secret', path: 'commands', body })
    await assert.rejects(call(), { code: 'NETWORK_ERROR' })
    await recordCommand(directory, origin, {
        ...body,
        input: { expectedVersion: '2', name: 'Read paper', id: 'task-a' },
    })
    assert.equal((await call()).replayed, true)
    assert.equal(changes, 1)
    await assert.rejects(recordCommand(directory, origin, { ...body, input: { ...body.input, name: 'Changed' } }))
    await assert.rejects(recordCommand(directory, 'https://grow.ischemist.com', body))
    const entry = await readFile(join(directory, `${body.mutationId}.json`), 'utf8')
    assert.ok(!entry.includes('Read paper'))
    assert.equal((await stat(join(directory, `${body.mutationId}.json`))).mode & 0o777, 0o600)
})

async function privateHome(t) {
    const home = await mkdtemp(join(tmpdir(), 'grow-connection-test-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    return home
}
const localConnection = (port) => resolveConnection({ alias: 'local', port }, null)

void test('successful setup remembers the endpoint for fresh flag-free commands without persisting a credential', async (t) => {
    const home = await privateHome(t)
    const origins = []
    const requests = []
    const services = {
        home,
        storeCredential: (origin) => origins.push(origin),
        loadCredential: (origin) => {
            origins.push(origin)
            return 'synthetic-credential'
        },
        request: async (request) => {
            requests.push(request)
            return { operations: [] }
        },
    }
    await runCli(['setup', '--connection', 'local', '--port', '3020'], services)
    await runCli(['capabilities'], services)
    await runCli(['capabilities', '--connection', 'local'], services)
    assert.deepEqual(origins, Array(3).fill('http://127.0.0.1:3020'))
    assert.deepEqual(
        requests.map(({ alias, port }) => ({ alias, port })),
        Array(2).fill({ alias: 'local', port: 3020 })
    )
    const filename = join(home, '.local', 'share', 'grow-planning', 'connection.json')
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), {
        version: 1,
        selectedConnection: 'local',
        localPort: 3020,
    })
    assert.equal((await stat(filename)).mode & 0o777, 0o600)
    assert.equal((await stat(join(home, '.local', 'share', 'grow-planning'))).mode & 0o777, 0o700)
})

void test('explicit ports override a single command while local defaults and selected environments remain bound', async (t) => {
    const home = await privateHome(t)
    assert.deepEqual(resolveConnection({ alias: 'local' }, null), localConnection(3000))
    assert.throws(() => resolveConnection({}, null))
    await saveConnectionSelection(localConnection(3020), home)
    const selection = await readConnectionSelection(home)
    assert.equal(resolveConnection({ alias: 'local', port: 3030 }, selection).port, 3030)
    assert.equal(resolveConnection({}, selection).port, 3020)
    assert.throws(() => resolveConnection({ alias: 'production', port: 3020 }, selection))
    assert.throws(() => resolveConnection({ alias: 'local', port: NaN }, selection))
    assert.throws(() => resolveConnection({ alias: 'http://attacker.invalid' }, selection))
    await saveConnectionSelection(resolveConnection({ alias: 'production' }, selection), home)
    const production = await readConnectionSelection(home)
    assert.equal(resolveConnection({}, production).origin, 'https://grow.ischemist.com')
    assert.equal(resolveConnection({ alias: 'local' }, production).port, 3020)
    assert.throws(() => resolveConnection({ port: 3030 }, production))
})

void test('select reuses an existing origin-bound Keychain credential and remembers it only after authentication', async (t) => {
    const home = await privateHome(t)
    const origins = []
    let authenticated = false
    const services = {
        home,
        loadCredential: (origin) => {
            origins.push(origin)
            return 'synthetic-credential'
        },
        storeCredential: () => assert.fail('Selection must not rewrite a Keychain credential'),
        request: async ({ alias, port, path }) => {
            assert.equal(alias, 'local')
            assert.equal(port, 3020)
            assert.equal(path, 'capabilities')
            assert.equal(await readConnectionSelection(home), null)
            authenticated = true
            return { operations: [] }
        },
    }
    await runCli(['select', '--connection', 'local', '--port', '3020'], services)
    assert.equal(authenticated, true)
    assert.deepEqual(origins, ['http://127.0.0.1:3020'])
    assert.equal((await readConnectionSelection(home)).localPort, 3020)
})

void test('failed setup or selection never replaces a previous endpoint or falls back to production', async (t) => {
    const home = await privateHome(t)
    await saveConnectionSelection(localConnection(3020), home)
    let calls = 0
    const services = {
        home,
        storeCredential: () => {
            throw new Error('Synthetic setup failure')
        },
        loadCredential: (origin) => {
            assert.equal(origin, 'http://127.0.0.1:3030')
            return 'synthetic-credential'
        },
        request: async () => {
            calls++
            throw new Error('Synthetic authentication failure')
        },
    }
    await assert.rejects(runCli(['setup', '--connection', 'local', '--port', '3030'], services))
    await assert.rejects(runCli(['select', '--connection', 'local', '--port', '3030'], services))
    assert.equal(calls, 1)
    assert.equal((await readConnectionSelection(home)).localPort, 3020)
})

void test('forget preserves endpoint preferences and a missing credential stops before HTTP', async (t) => {
    const home = await privateHome(t)
    await saveConnectionSelection(localConnection(3020), home)
    const removed = []
    let credentialPresent = true
    const services = {
        home,
        forgetCredential: (origin) => {
            removed.push(origin)
            if (origin === 'http://127.0.0.1:3020') credentialPresent = false
        },
        loadCredential: (origin) => {
            assert.equal(origin, 'http://127.0.0.1:3020')
            assert.equal(credentialPresent, false)
            throw new Error('No saved credential')
        },
        request: () => assert.fail('Missing credentials must stop before HTTP'),
    }
    await runCli(['forget', '--connection', 'local', '--port', '3030'], services)
    assert.equal((await readConnectionSelection(home)).localPort, 3020)
    await runCli(['forget'], services)
    assert.deepEqual(await readConnectionSelection(home), { version: 1, selectedConnection: 'local', localPort: 3020 })
    assert.deepEqual(removed, ['http://127.0.0.1:3030', 'http://127.0.0.1:3020'])
    await assert.rejects(runCli(['capabilities'], services), /No saved credential/)
})

void test('forget cannot delete preferences while another connection selection is in flight', async (t) => {
    const home = await privateHome(t)
    await saveConnectionSelection(localConnection(3020), home)
    let allowSelection, selectionStarted
    const selectionReady = new Promise((resolve) => {
        selectionStarted = resolve
    })
    const requestReady = new Promise((resolve) => {
        allowSelection = resolve
    })
    const selected = runCli(['select', '--connection', 'local', '--port', '3030'], {
        home,
        loadCredential: (origin) => {
            assert.equal(origin, 'http://127.0.0.1:3030')
            return 'synthetic-credential'
        },
        request: async () => {
            selectionStarted()
            await requestReady
            return { operations: [] }
        },
    })
    await selectionReady
    await runCli(['forget'], { home, forgetCredential: (origin) => assert.equal(origin, 'http://127.0.0.1:3020') })
    assert.equal((await readConnectionSelection(home)).localPort, 3020)
    allowSelection()
    await selected
    assert.equal((await readConnectionSelection(home)).localPort, 3030)
    await runCli(['forget', '--connection', 'local', '--port', '3020'], { home, forgetCredential: () => {} })
    assert.equal((await readConnectionSelection(home)).localPort, 3030)
})

void test('malformed or secret-shaped metadata fails before any credential lookup or request', async (t) => {
    const home = await privateHome(t)
    await saveConnectionSelection(localConnection(3020), home)
    const filename = join(home, '.local', 'share', 'grow-planning', 'connection.json')
    const services = {
        home,
        loadCredential: () => assert.fail('Must not retrieve a credential'),
        request: () => assert.fail('Must not connect'),
    }
    for (const content of [
        '{',
        JSON.stringify({ version: 1, selectedConnection: 'local', localPort: 3020, token: 'never-echo-this' }),
        JSON.stringify({ version: 1, selectedConnection: 'https://attacker.invalid', localPort: 3020 }),
        'x'.repeat(4097),
    ]) {
        await writeFile(filename, content)
        await assert.rejects(runCli(['capabilities', '--connection', 'local', '--port', '3020'], services), (error) => {
            assert.equal(error.message.includes('never-echo-this'), false)
            return /metadata is invalid or unsafe/.test(error.message)
        })
    }
})

void test('unsafe permissions, symlinks and hard links cannot redirect metadata reads or writes', async (t) => {
    const home = await privateHome(t)
    await saveConnectionSelection(localConnection(3020), home)
    const directory = join(home, '.local', 'share', 'grow-planning')
    const filename = join(directory, 'connection.json')
    await chmod(filename, 0o644)
    await assert.rejects(readConnectionSelection(home))
    await chmod(filename, 0o600)
    const other = join(home, 'other.json')
    await link(filename, other)
    await assert.rejects(readConnectionSelection(home))
    await rm(other)
    await rm(filename)
    await writeFile(other, '{}', { mode: 0o600 })
    await symlink(other, filename)
    await assert.rejects(readConnectionSelection(home))
    await assert.rejects(saveConnectionSelection(localConnection(3030), home))
    assert.equal(await readFile(other, 'utf8'), '{}')
    const anotherHome = await privateHome(t)
    await symlink(directory, join(anotherHome, '.local'))
    await assert.rejects(saveConnectionSelection(localConnection(3030), anotherHome))
})

void test('concurrent selections publish complete private metadata and leave no temporary files', async (t) => {
    const home = await privateHome(t)
    await Promise.all([
        saveConnectionSelection(localConnection(3020), home),
        saveConnectionSelection(localConnection(3030), home),
    ])
    assert.ok([3020, 3030].includes((await readConnectionSelection(home)).localPort))
    assert.deepEqual(await readdir(join(home, '.local', 'share', 'grow-planning')), ['connection.json'])
})
