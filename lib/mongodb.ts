import { MongoClient } from "mongodb"

const uri = process.env.MONGODB_URI || ""
const options = {}

let client: MongoClient | undefined
let clientPromise: Promise<MongoClient> | undefined

export function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise
  if (!uri) {
    clientPromise = Promise.reject(new Error("MONGODB_URI is not set"))
    return clientPromise
  }
  client = new MongoClient(uri, options)
  clientPromise = client.connect()
  return clientPromise
}

export default getMongoClient()
