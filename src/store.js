/**
 * Storage.
 *
 * A room outlives any single request, so it cannot live in a module variable —
 * on Vercel each request may hit a different instance. Two backends:
 *
 *   memory  local development and tests
 *   redis   Upstash's REST API (what Vercel KV and the Upstash integration give you)
 *
 * The shape is deliberately narrow: a room JSON blob plus three hashes whose
 * fields are each owned by exactly one writer, so two players acting at the same
 * moment can never overwrite each other.
 */

const ROOM_TTL_SECONDS = 12 * 60 * 60;

const keys = {
  room: (code) => `gt:room:${code}`,
  players: (code) => `gt:players:${code}`,
  topics: (code) => `gt:topics:${code}`,
  answers: (code, questionId) => `gt:answers:${code}:${questionId}`
};

/* --------------------------------------------------------------------- memory */

export function createMemoryStore() {
  const data = new Map();
  const locks = new Map();
  const get = (key) => data.get(key);
  const put = (key, value) => { data.set(key, value); };

  return {
    kind: 'memory',
    async loadRoom(code) {
      return get(keys.room(code)) ? JSON.parse(get(keys.room(code))) : null;
    },
    async saveRoom(room) {
      put(keys.room(room.code), JSON.stringify(room));
    },
    async deleteRoom(code) {
      for (const key of [...data.keys()]) if (key.includes(`:${code}`)) data.delete(key);
    },
    async loadPlayers(code) {
      return Object.values(get(keys.players(code)) ?? {}).map((value) => JSON.parse(value));
    },
    async savePlayer(code, player) {
      const bucket = get(keys.players(code)) ?? {};
      bucket[player.id] = JSON.stringify(player);
      put(keys.players(code), bucket);
    },
    async savePlayers(code, players) {
      const bucket = get(keys.players(code)) ?? {};
      for (const player of players) bucket[player.id] = JSON.stringify(player);
      put(keys.players(code), bucket);
    },
    async loadTopics(code) {
      return Object.values(get(keys.topics(code)) ?? {}).map((value) => JSON.parse(value));
    },
    async addTopics(code, topics) {
      const bucket = get(keys.topics(code)) ?? {};
      for (const topic of topics) bucket[topic.id] = JSON.stringify(topic);
      put(keys.topics(code), bucket);
    },
    async loadAnswers(code, questionId) {
      if (!questionId) return {};
      const bucket = get(keys.answers(code, questionId)) ?? {};
      return Object.fromEntries(Object.entries(bucket).map(([id, value]) => [id, JSON.parse(value)]));
    },
    async saveAnswer(code, questionId, playerId, answer) {
      const bucket = get(keys.answers(code, questionId)) ?? {};
      bucket[playerId] = JSON.stringify(answer);
      put(keys.answers(code, questionId), bucket);
    },
    /** First caller wins. Used so only one client closes a round. */
    async tryLock(name, ttlSeconds = 30) {
      const now = Date.now();
      const held = locks.get(name);
      if (held && held > now) return false;
      locks.set(name, now + ttlSeconds * 1000);
      return true;
    }
  };
}

/* ---------------------------------------------------------------------- redis */

export function redisConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/**
 * Upstash's REST protocol: POST a command as a JSON array, or POST an array of
 * commands to /pipeline to run several in one round trip.
 */
export function createRedisStore({ url, token, fetchImpl = fetch }) {
  async function send(body, path = '') {
    const response = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Storage request failed (${response.status}). Check your Redis credentials.`);
    }
    return response.json();
  }

  const command = async (...parts) => (await send(parts)).result;
  const pipeline = async (commands) => {
    const results = await send(commands, '/pipeline');
    return results.map((entry) => entry.result);
  };

  /** Upstash returns a hash as a flat [field, value, field, value] array. */
  const parseHash = (flat) => {
    const out = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    } else if (flat && typeof flat === 'object') {
      Object.assign(out, flat);
    }
    return out;
  };

  const parseValues = (flat) => Object.entries(parseHash(flat)).map(([field, value]) => {
    // Already-decoded objects are fine; anything else has to be readable JSON,
    // and if it is not, say which field rather than failing with a bare
    // "Unexpected token" from somewhere deep in a request handler.
    if (value && typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Stored value for "${field}" is not readable JSON (got ${typeof value}).`);
    }
  });

  return {
    kind: 'redis',
    async loadRoom(code) {
      const raw = await command('GET', keys.room(code));
      return raw ? JSON.parse(raw) : null;
    },
    async saveRoom(room) {
      await pipeline([
        ['SET', keys.room(room.code), JSON.stringify(room)],
        ['EXPIRE', keys.room(room.code), ROOM_TTL_SECONDS]
      ]);
    },
    async deleteRoom(code) {
      await command('DEL', keys.room(code), keys.players(code), keys.topics(code));
    },
    async loadPlayers(code) {
      return parseValues(await command('HGETALL', keys.players(code)));
    },
    async savePlayer(code, player) {
      await pipeline([
        ['HSET', keys.players(code), player.id, JSON.stringify(player)],
        ['EXPIRE', keys.players(code), ROOM_TTL_SECONDS]
      ]);
    },
    async savePlayers(code, players) {
      if (!players.length) return;
      const flat = players.flatMap((player) => [player.id, JSON.stringify(player)]);
      await pipeline([
        ['HSET', keys.players(code), ...flat],
        ['EXPIRE', keys.players(code), ROOM_TTL_SECONDS]
      ]);
    },
    async loadTopics(code) {
      return parseValues(await command('HGETALL', keys.topics(code)));
    },
    async addTopics(code, topics) {
      if (!topics.length) return;
      const flat = topics.flatMap((topic) => [topic.id, JSON.stringify(topic)]);
      await pipeline([
        ['HSET', keys.topics(code), ...flat],
        ['EXPIRE', keys.topics(code), ROOM_TTL_SECONDS]
      ]);
    },
    async loadAnswers(code, questionId) {
      if (!questionId) return {};
      const hash = parseHash(await command('HGETALL', keys.answers(code, questionId)));
      return Object.fromEntries(Object.entries(hash).map(([id, value]) => [id, JSON.parse(value)]));
    },
    async saveAnswer(code, questionId, playerId, answer) {
      await pipeline([
        ['HSET', keys.answers(code, questionId), playerId, JSON.stringify(answer)],
        ['EXPIRE', keys.answers(code, questionId), ROOM_TTL_SECONDS]
      ]);
    },
    /** SET NX: exactly one caller gets `OK`, everyone else gets null. */
    async tryLock(name, ttlSeconds = 30) {
      const result = await command('SET', `gt:lock:${name}`, '1', 'NX', 'EX', String(ttlSeconds));
      return result === 'OK' || result?.result === 'OK';
    }
  };
}

/**
 * Work out what storage this deployment actually has, and say so plainly.
 *
 * The failure worth catching: Upstash hands out two different things — a TCP
 * connection string (`redis://…`) and a pair of REST credentials. This app talks
 * REST, because that is what works from a serverless function. If only the TCP
 * URL is present the app would quietly fall back to memory and the game would
 * break in a baffling way mid-party, so it is called out instead.
 */
export function storageDiagnosis(env = process.env) {
  const config = redisConfig(env);
  if (config) {
    if (/^rediss?:\/\//.test(config.url)) {
      return {
        kind: 'memory',
        ok: false,
        problem: 'The Redis URL is a TCP connection string (redis://…), but this app needs the '
          + 'REST URL, which looks like https://your-db.upstash.io. Copy the REST URL and REST '
          + 'token from the Upstash console into KV_REST_API_URL and KV_REST_API_TOKEN.'
      };
    }
    return { kind: 'redis', ok: true };
  }

  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_TOKEN;
  if (url && !token) {
    return { kind: 'memory', ok: false, problem: 'A Redis REST URL is set but its token is missing.' };
  }
  if (token && !url) {
    return { kind: 'memory', ok: false, problem: 'A Redis REST token is set but its URL is missing.' };
  }
  if (env.REDIS_URL || env.KV_URL) {
    return {
      kind: 'memory',
      ok: false,
      problem: 'Found REDIS_URL but no REST credentials. Upstash gives you both: this app needs '
        + 'the REST pair (KV_REST_API_URL and KV_REST_API_TOKEN), not the redis:// connection string.'
    };
  }
  return {
    kind: 'memory',
    ok: true,
    problem: null,
    note: 'No Redis configured. Fine on one machine; in production every player needs the same store.'
  };
}

/** Redis when it is configured, memory otherwise. */
export function createStore(env = process.env) {
  const config = redisConfig(env);
  const diagnosis = storageDiagnosis(env);
  if (config && diagnosis.ok) return createRedisStore(config);
  const store = createMemoryStore();
  store.problem = diagnosis.problem ?? null;
  return store;
}

/** One process-wide store, so local development keeps its rooms between requests. */
let shared = null;
export function sharedStore(env = process.env) {
  if (!shared) shared = createStore(env);
  return shared;
}

export { keys };
