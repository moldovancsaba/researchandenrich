import { MongoClient, Db } from "mongodb"

/**
 * MongoDB access layer.
 *
 * The previous implementation had three compounding defects:
 *   - `clientPromise` was assigned only on the REJECT path, so the success path
 *     was never cached and every call constructed a new MongoClient and opened a
 *     new connection. On a cluster shared with salesleadgenerator and three
 *     tenant runtimes, that leaks toward the Atlas connection cap.
 *   - `export default getMongoClient()` invoked at module evaluation, so a
 *     connection was attempted at import (including during `next build`) and an
 *     unset MONGODB_URI produced an unhandled rejection.
 *   - `client.db()` with no argument selects whatever database the URI's path
 *     specifies. The configured URIs end `/?appName=sales` with no path, which
 *     resolves to `test`.
 */

export class ConfigurationError extends Error {
  constructor(variable: string) {
    super(`${variable} is not set`)
    this.name = "ConfigurationError"
  }
}

const POOL = {
  maxPoolSize: 10,
  // 0 for serverless: an instance may serve one request and be discarded, so
  // pre-warming connections wastes the shared cluster's capacity.
  minPoolSize: 0,
  maxIdleTimeMS: 30_000,
  // Fail fast rather than hanging the request until the platform timeout.
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
}

// Next.js re-evaluates modules on every edit in development, which would
// otherwise leak one client per file save.
const globalForMongo = globalThis as unknown as {
  _mongoClientPromise?: Promise<MongoClient>
}

let clientPromise: Promise<MongoClient> | undefined

export function getMongoClient(): Promise<MongoClient> {
  if (process.env.NODE_ENV !== "production" && globalForMongo._mongoClientPromise) {
    return globalForMongo._mongoClientPromise
  }
  if (clientPromise) return clientPromise

  const uri = process.env.MONGODB_URI
  if (!uri || uri.trim() === "") {
    // Rejected WITHOUT caching: a later-configured environment must be able to
    // recover without a code deploy.
    return Promise.reject(new ConfigurationError("MONGODB_URI"))
  }

  const promise = new MongoClient(uri, POOL).connect().catch((err) => {
    // Clear on failure. A naive memoisation caches the rejection forever, so a
    // single transient failure at cold start would leave that instance
    // permanently broken -- trading a connection leak for an availability bug.
    clientPromise = undefined
    if (process.env.NODE_ENV !== "production") {
      globalForMongo._mongoClientPromise = undefined
    }
    throw err
  })

  clientPromise = promise
  if (process.env.NODE_ENV !== "production") {
    globalForMongo._mongoClientPromise = promise
  }
  return promise
}

let warnedAboutImplicitDb = false

/**
 * Select the application database.
 *
 * MONGODB_DB is the intended configuration. It is NOT hard-required, because
 * making it so would break a running deployment that has never set it -- the
 * live collections may sit in whatever database the URI resolves to today, and
 * that could not be verified from the repository. When it is unset this falls
 * back to the previous implicit behaviour and warns once with the resolved
 * name, so the ambiguity is visible rather than silent.
 *
 * Set MONGODB_DB and the fallback disappears. Confirm the value against the
 * live cluster first: pointing at the wrong database presents as an empty
 * dashboard, which looks exactly like a working deployment with no data.
 */
export async function getDb(): Promise<Db> {
  const client = await getMongoClient()
  const dbName = process.env.MONGODB_DB

  if (dbName && dbName.trim() !== "") {
    return client.db(dbName.trim())
  }

  const db = client.db()
  if (!warnedAboutImplicitDb) {
    warnedAboutImplicitDb = true
    console.warn(
      `[mongodb] MONGODB_DB is not set; falling back to the database implied by ` +
        `MONGODB_URI, resolved as "${db.databaseName}". Set MONGODB_DB explicitly.`
    )
  }
  return db
}

/** Reachability probe for /api/health. Never throws. */
export async function getDbHealth(): Promise<{
  ok: boolean
  latencyMs: number
  error?: string
}> {
  const started = Date.now()
  try {
    const db = await getDb()
    await db.command({ ping: 1 })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      // Error CLASS only. The message can carry hostnames and topology.
      error: err instanceof Error ? err.constructor.name : "Unknown",
    }
  }
}
