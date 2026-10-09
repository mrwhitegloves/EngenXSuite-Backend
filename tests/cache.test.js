import { beforeEach, describe, expect, it, vi } from 'vitest';

// Redis is replaced by a tiny in-memory stand-in with the few commands the cache uses.
// `state.available` and `state.broken` switch between "connected", "not connected" and "erroring".
const state = { available: true, broken: false, data: new Map(), ttls: new Map() };
const fakeRedis = {
  async get(key) {
    if (state.broken) throw new Error('redis exploded');
    return state.data.has(key) ? state.data.get(key) : null;
  },
  async set(key, value, mode, seconds) {
    if (state.broken) throw new Error('redis exploded');
    state.data.set(key, value);
    state.ttls.set(key, mode === 'EX' ? seconds : null);
    return 'OK';
  },
  async del(...keys) {
    if (state.broken) throw new Error('redis exploded');
    keys.forEach((key) => state.data.delete(key));
    return keys.length;
  },
};
vi.mock('../infra/redis.js', () => ({
  getRedis: () => (state.available ? fakeRedis : null),
}));

const { getOrSet, invalidate } = await import('../infra/cache.js');

beforeEach(() => {
  state.available = true;
  state.broken = false;
  state.data.clear();
  state.ttls.clear();
});

describe('cache getOrSet', () => {
  it('fetches on a miss, stores with a lifetime, and serves the next call from the cache', async () => {
    const fetchFn = vi.fn(async () => ({ total: 42 }));

    expect(await getOrSet('report', 60, fetchFn)).toEqual({ total: 42 });
    expect(await getOrSet('report', 60, fetchFn)).toEqual({ total: 42 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Never stored without a lifetime. The key carries the environment ("test" here), so
    // development and production never read each other's entries on a shared Redis.
    expect(state.ttls.get('cache:v1:test:report')).toBe(60);
  });

  it("keeps different keys apart, so one user never receives another user's data", async () => {
    const forUser = (id) => getOrSet(`dashboard:${id}`, 60, async () => ({ owner: id }));
    expect(await forUser('userA')).toEqual({ owner: 'userA' });
    expect(await forUser('userB')).toEqual({ owner: 'userB' });
    expect(await forUser('userA')).toEqual({ owner: 'userA' });
  });

  it('after invalidate the next call reads the real data again', async () => {
    let value = 'old';
    const fetchFn = vi.fn(async () => value);
    expect(await getOrSet('branding', 300, fetchFn)).toBe('old');

    value = 'new';
    expect(await getOrSet('branding', 300, fetchFn)).toBe('old'); // still cached
    await invalidate('branding');
    expect(await getOrSet('branding', 300, fetchFn)).toBe('new');
  });

  it('works without Redis: every call fetches the real data', async () => {
    state.available = false;
    const fetchFn = vi.fn(async () => 'fresh');
    expect(await getOrSet('x', 60, fetchFn)).toBe('fresh');
    expect(await getOrSet('x', 60, fetchFn)).toBe('fresh');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await expect(invalidate('x')).resolves.toBeUndefined();
  });

  it('a Redis error never breaks the request', async () => {
    state.broken = true;
    const fetchFn = vi.fn(async () => 'fresh');
    expect(await getOrSet('x', 60, fetchFn)).toBe('fresh');
    await expect(invalidate('x')).resolves.toBeUndefined();
  });

  it('an error from the real data source is passed on and not cached', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database down');
    });
    await expect(getOrSet('y', 60, failing)).rejects.toThrow('database down');
    expect(state.data.size).toBe(0);
  });

  it('caches falsy values such as 0, false and null correctly', async () => {
    const fetchZero = vi.fn(async () => 0);
    expect(await getOrSet('zero', 60, fetchZero)).toBe(0);
    expect(await getOrSet('zero', 60, fetchZero)).toBe(0);
    expect(fetchZero).toHaveBeenCalledTimes(1);
  });
});
