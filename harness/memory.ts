import { generateText } from "ai";
import type { ModelMessage } from "ai";
import {model} from "./model"
import { SYSTEM_PROMPT } from "./system-prompt";

export const MAX_CONTEXT_TOKENS = 500
export const KEEP_CONTEXT_TOKENS = 200

//don't use this in prod, you should use some kind of real tokenizer
export function estimateTokens(messages: ModelMessage[]): number {
    const chars = messages.reduce(
        (n, m) => 
            n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
            0,
        );
        return Math.ceil(chars/4)
}

//build the context for the agent, don't use this in prod, can probably buy a product for this or make a better one
export function buildContext(
    task: string,
    summary: string,
    turns: ModelMessage[][]
): ModelMessage[] { //returns new model messages
    const context: ModelMessage[] = [
        { role:'system', content: SYSTEM_PROMPT},
        {role: 'user', content: task}
    ]

    if(summary) {
        context[0].content += `Summary of earlier work so far:\n${summary} `
    }

    for(const turn of turns) {
        context.push(...turn)
    }

    return context

}


//create a summarize function that calls an LLM to summarize our context
export async function summarize(oldTurns: ModelMessage[][], priorSummary: string) {
    const transcript = oldTurns
    .flat() //flatten because it's an array of an array
    //map over each of them and convert it to a string
    //basically "here's a role and here is what was said"
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')
    .slice(0, 6000)

    const {text} = await generateText({
        model,
        messages: [
            {
                role: "system",
                content: 
                    "You compress an agent's work log into a short running summary. Preserve concrete facts: item ids, categories, draft ids, amounts, and what was already sent. Be terse.",

            },
            {
                role: "user",
                content: `Prior summary: \n${priorSummary || "(none)"}\n\n Fold in the newer work: \n${transcript}\n\nReturn the updated summary.`
            }
        ],

    })

    return text
}