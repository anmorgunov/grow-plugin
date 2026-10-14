import { spawnSync } from 'node:child_process'

export function connectionOrigin(alias, port = 3000) {
    if (alias === 'production') return 'https://grow.ischemist.com'
    if (alias !== 'local' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Choose production or local with a valid loopback port.')
    }
    return `http://127.0.0.1:${port}`
}

function requireKeychain() {
    if (process.platform !== 'darwin') throw new Error('Credential setup requires macOS Keychain.')
}

export function storeCredential(origin) {
    requireKeychain()
    if (!process.stdin.isTTY) throw new Error('Run setup yourself in an interactive terminal.')
    // security prompts without echo when -w is the final option; no secret enters Node or argv.
    const result = spawnSync(
        '/usr/bin/security',
        ['add-generic-password', '-U', '-a', origin, '-s', 'com.ischemist.grow.planning', '-w'],
        { stdio: 'inherit' }
    )
    if (result.status !== 0) throw new Error('Keychain setup did not complete.')
}

export function loadCredential(origin) {
    requireKeychain()
    const result = spawnSync(
        '/usr/bin/security',
        ['find-generic-password', '-a', origin, '-s', 'com.ischemist.grow.planning', '-w'],
        { encoding: 'utf8', maxBuffer: 4096, timeout: 30000 }
    )
    if (result.status !== 0) throw new Error('Credential unavailable. Run human setup for this connection.')
    const token = result.stdout.trim()
    if (!token || token.length > 2048 || /[\r\n]/.test(token)) throw new Error('Credential is invalid.')
    return token
}

export function forgetCredential(origin) {
    requireKeychain()
    const result = spawnSync(
        '/usr/bin/security',
        ['delete-generic-password', '-a', origin, '-s', 'com.ischemist.grow.planning'],
        { stdio: 'ignore' }
    )
    if (result.status !== 0) throw new Error('Credential removal failed.')
}
