import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const live = join(dirname(fileURLToPath(import.meta.url)), '..', 'live')
const compose = parse(readFileSync(join(live, 'docker-compose.yml'), 'utf-8')) as {
  services: Record<string, Record<string, any>>
  networks: Record<string, Record<string, any> | null>
  volumes?: Record<string, unknown>
}

/**
 * The live matrix starts real Overleaf servers on a machine that may also run
 * someone's production instance. These are the properties that keep it from
 * ever being reachable, mistaken for the real thing, or left behind.
 */
describe('live matrix isolation', () => {
  const services = Object.entries(compose.services)

  it('publishes no ports and never touches the host network', () => {
    for (const [name, svc] of services) {
      expect(svc.ports, `${name}.ports`).toBeUndefined()
      expect(svc.expose, `${name}.expose`).toBeUndefined()
      expect(svc.network_mode, `${name}.network_mode`).toBeUndefined()
      expect(svc.networks, `${name}.networks`).toBeDefined()
    }
  })

  it('keeps Overleaf and the test runner on an internal network; only the dependency installer has egress', () => {
    expect(compose.networks.sandbox).toEqual({ internal: true })
    for (const name of ['sharelatex', 'mongo', 'redis', 'runner']) {
      expect(compose.services[name]!.networks, name).toEqual(['sandbox'])
    }
    expect(compose.services.prepare!.networks).toEqual(['egress'])
  })

  it('builds nothing, fixes no container names and mounts nothing into the instance', () => {
    for (const [name, svc] of services) {
      expect(svc.build, `${name}.build`).toBeUndefined()
      expect(svc.container_name, `${name}.container_name`).toBeUndefined()
      expect(svc.restart, `${name}.restart`).toBeUndefined()
    }
    for (const name of ['sharelatex', 'mongo', 'redis']) {
      expect(compose.services[name]!.volumes, `${name}.volumes`).toBeUndefined()
    }
    // The checkout is only ever mounted read-only.
    const binds = (compose.services.prepare!.volumes as string[]).filter((v) => v.includes('REPO_ROOT'))
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatch(/:ro$/)
    expect(compose.services.runner!.volumes).toEqual(['work:/work'])
  })

  it('lists versions whose env files exist, newest first, covering every supported major', () => {
    const rows = readFileSync(join(live, 'versions.conf'), 'utf-8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row, row.join(' ')).toHaveLength(6)
      const [version, image, , shell, , envFile] = row as [string, string, string, string, string, string]
      expect(image).toBe(`sharelatex/sharelatex:${version}`)
      expect(['mongo', 'mongosh']).toContain(shell)
      expect(existsSync(join(live, envFile)), envFile).toBe(true)
      // 5.0 renamed every SHARELATEX_* variable and refuses to start with the old names.
      expect(envFile).toBe(Number(version.split('.')[0]) >= 5 ? 'env.overleaf' : 'env.sharelatex')
    }
    expect(new Set(rows.map((r) => r[0]!.split('.')[0]))).toEqual(new Set(['6', '5', '4']))
  })

  it('tears down on every exit path and only removes images it pulled itself', () => {
    const script = readFileSync(join(live, 'run-matrix.sh'), 'utf-8')
    expect(script).toMatch(/trap on_exit EXIT/)
    // A trap only fires between foreground commands: the long ones must be waited on, not run inline.
    expect(script).toMatch(/interruptible dc run --rm --no-deps -T runner/)
    expect(script).not.toMatch(/^\s*(if )?dc run /m)
    // `rm -f` without -v orphans the images' anonymous data volumes, which carry no label to find them by.
    expect(script).toMatch(/docker rm -f -v \$left/)
    expect(script).not.toMatch(/docker rm -f \$left/)
    expect(script).toMatch(/down --volumes --remove-orphans/)
    expect(script).toMatch(/if ! image_present "\$needed"; then[\s\S]*?pulled_images\+=\("\$needed"\)/)
    expect(script).not.toMatch(/docker (system|image|volume|builder|network) prune/)
  })
})
