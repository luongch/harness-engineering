// import { config } from "dotenv";
// // Load secrets from .dev.vars (OPENAI_API_KEY, ...) before anything else.
// config({ path: ".dev.vars" });

import './env'
import {DBOS} from '@dbos-inc/dbos-sdk'

import {ensureSchema} from '../harness/db'
import {subscribe, history} from '../harness/bus'

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
// import { EventBus, createEmitter } from "../harness/bus";
// import { runAgent } from "../harness/runtime";
import { runAgentWorkflow } from "../harness/runtime";
import { EventType, type ClientMessage } from "@shared/events";

const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  await ensureSchema()
  DBOS.setConfig({name: 'harness', systemDatabaseUrl: process.env.DATABASE_URL})
  await DBOS.launch();

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ok: true})
  })

  const server = createServer(app);
  const ws = new WebSocketServer({ server, path: "/ws" });

  subscribe((event) => {
    const data = JSON.stringify(event)
    for(const client of ws.clients) {//for each client connected
      if(client.readyState === client.OPEN) {
        client.send(data)
      }
    }
  })

  ws.on('connection', async (socket: WebSocket) => {
    socket.on('message', async (raw) => {
      let message: ClientMessage
      try {
        message = JSON.parse(raw.toString())
      } catch(e) {
        return
      }

      if (message.type === 'submit_task') {
        await DBOS.startWorkflow(runAgentWorkflow)(message.input) //startWorkflow returns a function and then we call it immediately after passing in (message.input)
      }
    })

    for (const event of await history()) {
      socket.send(JSON.stringify(event)) //here is everything you missed since you were disconnected
    }
  })

  server.listen(PORT, () => {
    console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
  });

}

main().catch(error => {
  console.error('opps', error)
  process.exit()
})
// const app = express();
// app.get("/health", (_req, res) => {
//   res.json({ ok: true });
// });

// const server = createServer(app);
// const wss = new WebSocketServer({ server, path: "/ws" });
// const bus = new EventBus();

// Forward every event the harness emits to all connected inspectors.
// bus.subscribe((event) => {
//   const data = JSON.stringify(event);
//   for (const client of wss.clients) {
//     if (client.readyState === client.OPEN) client.send(data);
//   }
// });

// wss.on("connection", (socket: WebSocket) => {
//   // Replay the timeline so far so a fresh inspector isn't blank.
//   for (const event of bus.history()) socket.send(JSON.stringify(event));

//   socket.on("message", (raw) => {
//     let message: ClientMessage;
//     try {
//       message = JSON.parse(raw.toString());
//     } catch {
//       return; // ignore anything that isn't valid JSON
//     }

//     if (message.type === "submit_task") {
//       const emit = createEmitter(bus);
//       // Fire and forget — the agent reports everything via events, not a return value.
//       runAgent({ input: message.input, emit }).catch((error) => {
//         emit({ type: EventType.Log, level: "error", message: String(error) });
//       });
//     }
//   });
// });

// server.listen(PORT, () => {
//   console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
// });
