import { streamText } from "ai";
import { randomUUID } from "node:crypto";
import { EventType, type Emit } from "@shared/events";
import { model } from "./model";
import { runTool, tools } from "./tools";
import { SYSTEM_PROMPT } from "./system-prompt";
import {DBOS} from "@dbos-inc/dbos-sdk";
import type { ModelMessage, JSONValue, Tool } from "ai";
import { emit } from "./bus";
 
//convert this runtime into a workflow

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 10;
type ToolCall = {
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
}

//a turn is each time the LLM uses a tool call, basically when the user and LLM takes turns talking to each other
type Turn = {
  text: string,
  toolCalls: ToolCall[], //what tool calls were made this turn
  responseMessage: ModelMessage[]
}

//each time a break is called below is a turn
//so we're converting the below to ?????
async function modelTurn(workflowId: string, messages: ModelMessage[]) : Promise<Turn> {
  const result = streamText({model, messages, tools})

  for await (const part of result.fullStream) {
    if(part.type === 'text-delta') { //a chunk came in so we want to do an emit
      await emit({type: EventType.ModelDelta, workflowId, text: part.text})
    }
  }

  //get the tool calls
  const rawCalls = await result.toolCalls

  return {
    text: await result.text,
    toolCalls: rawCalls.map(c => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input
    })),
    responseMessage: (await result.response).messages
  }
}

//handle for one tool
async function toolStep(workflowId: string, call: ToolCall): Promise<Record<string, unknown>> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    args: call.input
  })

  const output = await runTool(call.toolName, call.input)
  await emit({
    type: EventType.ToolCompleted,
    workflowId,
    toolCallId: call.toolCallId
  })

  return output
}

// THE BRITTLE AGENT.
//
// This is a script with an LLM in the middle. It works in a demo and dies in
// production a dozen ways:
//
//   · the `messages` array lives in memory      → crash = total loss
//   · tools run with no mediation               → `sendReply` just fires
//   · history only grows                        → context bloat
//   · one agent does everything                 → no specialization
//
// Make it work, then look at everything it gets wrong.
// export async function runAgent(opts: { input: string;}): Promise<void> {
export async function agentWorkFlow( input: string): Promise<string> {
  // const { input } = opts;
  const workflowId = DBOS.workflowID ?? 'unknown' //updated to use dbos

  await DBOS.runStep(() =>  emit({ type: EventType.WorkflowStarted, workflowId, input }))

  // 

  // BRITTLE STATE: a plain in-memory array. If this process dies, it's gone.
  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input },
  ];

  // THE LOOP. We drive it ourselves — each pass is exactly one model turn,
  // because streamText does a single generation by default.
  let step = 0;
  while (step < MAX_STEPS) {
    //const result = streamText({ model, messages, tools }); //we don't need this anymore 
    const turn = await DBOS.runStep(()=> modelTurn(workflowId, messages), {name:`model-${step}`}) //although we removed the streamText we are still streaming so don't get confused

    // Forward everything the model does onto the harness event stream so the
    // inspector can render it. (`part.type` here is the AI SDK's, not ours.)
    // for await (const part of result.fullStream) {
    //   switch (part.type) {
    //     case "text-delta":
    //       emit({ type: EventType.ModelDelta, workflowId, text: part.text });
    //       break;
    //     case "tool-call":
    //       emit({
    //         type: EventType.ToolRequested,
    //         workflowId,
    //         toolCallId: part.toolCallId,
    //         name: part.toolName,
    //         args: part.input,
    //       });
    //       break;
    //     case "tool-result":
    //       emit({
    //         type: EventType.ToolCompleted,
    //         workflowId,
    //         toolCallId: part.toolCallId,
    //         result: part.output,
    //       });
    //       break;
    //     case "error":
    //       emit({ type: EventType.WorkflowFailed, workflowId, error: String(part.error) });
    //       return;
    //   }
    // } //don't need this for loop for now

    // Append the model's message(s) — including any tool results — to history.
    // messages.push(...(await result.response).messages);
    messages.push(...turn.responseMessage) //the updated way to push the messages

    // No more tool calls means the model answered. We're done.
    // const toolCalls = await result.toolCalls; //dont need anymore
    // if (toolCalls.length === 0) {
    if (turn.toolCalls.length === 0) {
      // const text = await result.text;
      // emit({ type: EventType.ModelCompleted, workflowId, text });
      // emit({ type: EventType.WorkflowCompleted, workflowId, output: text });

      await DBOS.runStep(() => emit({type: EventType.ModelCompleted, workflowId, text: turn.text}), {name:`model-done-${step}`})
      await DBOS.runStep(() => emit({type: EventType.WorkflowCompleted, workflowId, output: turn.text}), {name:`completed`})
      // return;
      return turn.text;
    }

    for (const call of turn.toolCalls) {
      const output = await DBOS.runStep(() => toolStep(workflowId, call), {
        name: `tool-${call.toolCallId}`
      })

      //feed results back to the mode
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: {type: 'json', value: output}
          }
        ]
      })
    }

    step++;
  }

  emit({
    type: EventType.WorkflowFailed,
    workflowId,
    error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
  });

  await DBOS.runStep(() => emit({
    type: EventType.WorkflowFailed,
    workflowId,
    error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
  }), {name: 'failed'} )

  return ''
}


//register it as a workflow in dbos otherwise the steps wont do anything
export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkFlow, {
  name: 'agentWorkflow'
})
