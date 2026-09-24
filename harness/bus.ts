import { randomUUID } from "node:crypto";
import type { AgentEvent, EventInput, Emit } from "@shared/events";
import { db, eventLog} from './db'

// The harness event bus. Two jobs now:
//   1. DURABLY persist every event to Postgres (so the timeline survives a crash)
//   2. broadcast it live to any connected inspector
//
// `emit` is async now — we write to the database before we hand the event out.
type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();


//when someone wants to subscribe to our events (clients)
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener) //prevent memory leaks by ensuring listeners are properly removed when no longer needed
}

export async function emit(input: EventInput): Promise<void> {
  //we get a new event
  const event: AgentEvent = {
    ...input,
    id: randomUUID(),
    ts: Date.now()
  }
  //insert it into the db first  to ensure they are safely persisted before telling every client about it
  await db.insert(eventLog).values({data: event})
  //tell every client about it
  for (const listener of listeners) {
    listener(event)
  }
}

//get back all our events
export async function history(): Promise<AgentEvent[]> {
  const rows = await db.select().from(eventLog).orderBy(eventLog.seq)
  return rows.map((row) => row.data)
}