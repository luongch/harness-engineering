import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { model } from "./model";
import { CHARGES, searchKB } from "./tools";

//read only subagents
//not bound to dbos
//run inline, doesn't get top of the line treatment

const getCharges = tool({
    description: "Look up a customer's charges",
    inputSchema: z.object({
        customerId: z.string()
    }),
    execute: async({customerId}) => CHARGES[customerId] ?? [],
})

const searchKnowledgeBase = tool({
    description: "Search the knowledge base",
    intputSchema: z.object({
        query: z.string()
    }),
    execute: async ({query}) => searchKB(query),
})

type Investigator = { systemPrompt: string; tools: ToolSet}

const INVESTIGATORS: Record<string, Investigator> = {
    billing: {
        systemPrompt:"You are a billing investigator. Use getCharges to find duplicate or erroneous charges. Report the charge ids, the amount, and the refund you'd recommend — concisely.",
        tools: {getCharges}
    },
    technical: {
        systemPrompt: "You are a technical investigator. Use searchKnowledgeBase to find known bugs and workarounds. Report the issue, any ticket, and the workaround — concisely.",
        tools: {searchKnowledgeBase}
    },
    sales: {
        systemPrompt: "You are a sales investigator. Use searchKnowledgeBase for pricing guidance, then state the relevant numbers and next step — concisely.",
        tools: {searchKnowledgeBase}
    }
}


//function that runs an investigate
export async function runInvestigator(agent: string, objective: string) {
    if(process.env.CHAOS_FAIL === agent) {
        throw new Error(`investigator '${agent}' crashed (CHAOS FAIL)`)
    }

    const investigator = INVESTIGATORS[agent]
    if(!investigator) {
        throw new Error('No investigator by that name')
    }

    const {text} = await generateText({
        model,
        system: investigator.systemPrompt,
        prompt: objective,
        tools: investigator.tools,
        stopWhen: stepCountIs(5)

    })

    return text
}
