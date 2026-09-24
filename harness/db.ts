import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { pgTable, bigserial, jsonb} from 'drizzle-orm/pg-core'
import type {AgentEvent } from '@shared/events'

const connectionString = process.env.DATABASE_URL

if(!connectionString) { //sanity check
    throw new Error('Please set your DATABASE_URL')
}

//create db client  
const client = postgres(connectionString, {max:5})

//wrapping it in drixzle basically makes it an SDK so we can do things like 
// db.______ etc etc
export const db = drizzle(client) 

//creating table in db
//create columns seq and data
//seq is the sequential order
//data is the payload of the event
export const eventLog = pgTable('event_log', {
    seq: bigserial('seq', {mode:'number'}).primaryKey(),
    data:jsonb('data').$type<AgentEvent>().notNull() //drizzle allows us to add a typescript type to it
})


//sanity check
//ensuring right schema is there
//runtime checker
export async function ensureSchema(): Promise<void> {
    await client`
    CREATE TABLE IF NOT EXISTS event_log(
        seq bigserial PRIMARY KEY,
        data jsonb NOT NULL
    )
    `
}