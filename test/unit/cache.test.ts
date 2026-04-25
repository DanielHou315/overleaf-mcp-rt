import { describe, it, expect, vi } from 'vitest'
import { ProjectCache } from '../../src/overleaf/cache.js'
import { ProjectTree } from '../../src/overleaf/tree.js'

describe('ProjectCache', () => {
  it('fetches once within the TTL', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    const a = await cache.get('p1')
    const b = await cache.get('p1')
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches after TTL expiry', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 10 })
    await cache.get('p1')
    await new Promise((r) => setTimeout(r, 20))
    await cache.get('p1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate() forces a refetch', async () => {
    const fetcher = vi.fn(async (id: string) =>
      new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }]),
    )
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    await cache.get('p1')
    cache.invalidate('p1')
    await cache.get('p1')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent requests for the same id', async () => {
    let resolved = false
    const fetcher = vi.fn(async (id: string) => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
      return new ProjectTree([{ kind: 'text', path: 'main.tex', content: id }])
    })
    const cache = new ProjectCache(fetcher, { ttlMs: 60_000 })
    const [a, b] = await Promise.all([cache.get('p1'), cache.get('p1')])
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(true)
  })
})
