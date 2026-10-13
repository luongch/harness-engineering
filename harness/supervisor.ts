import { DBOS } from "@dbos-inc/dbos-sdk";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { EventType } from "@shared/events";
import { emit } from "./bus";
import { model } from "./model";
import { runInvestigator } from "./investigators";
//the supervisor's job is to determine if we need some investigators or not

// The PLAN is a first-class artifact: a structured object the supervisor emits,
// the inspector renders, the synthesis step reads, and that survives a crash.
const PlanSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string().describe("short id, e.g. 'billing'"),
      agent: z.enum(["billing", "technical", "sales"]),
      objective: z.string().describe("what this investigator should find out"),
    }),
  ),
});
type Plan = z.infer<typeof PlanSchema>;

async function makePlan(task: string) {
    const { object } = await generateObject({
    model,
    schema: PlanSchema,
    system:
      "Decompose a customer escalation into independent sub-tasks — one per area the message actually raises (billing / technical / sales). Only include relevant areas.",
    prompt: task,
  });
  return object;
}

// async function makePlan(task: string) {
//     const { output } = await generateText({
//     model,
//     output: Output.object({ schema: PlanSchema }),
//     system:
//       "Decompose a customer escalation into independent sub-tasks — one per area the message actually raises (billing / technical / sales). Only include relevant areas.",
//     prompt: task,
//   });
//   return output;
// }

async function synthesize(task: string, findings: {agent: string, findings: string}[]) {
    const {text} = await generateText({
        model,
        system:
        "You are a support lead. Using your investigators' findings, write ONE clear, friendly reply to the customer that addresses every point they raised. If an area's investigation is missing, acknowledge it briefly and say you'll follow up.",
        prompt: `Customer escalation:\n${task}\n\nInvestigator findings:\n${
        findings.map((f) => `[${f.agent}] ${f.findings}`).join("\n\n") || "(none)"
        }`,
    })

    return text
}


async function supervisorWorkflow(task: string) {
    const workflowId = DBOS.workflowID ?? "unknown" //can you make a new one or is it unknown?

    await DBOS.runStep(
        () => emit({ //emit always interacts with the db
            type: EventType.WorkflowStarted, //hey we just started a work flow
            workflowId, //here is the id
            input:task // and here is the task
        }),
        {name: "started"}
    )

    //create a plan
    //do I wrap in a step or not?
    //yes it needs a step otherwise it is in the work flow and if it is in a work flow 
    // then it happens everytime
    // we dont want to make a plan everytime if the workflow gets changed

    const plan = await DBOS.runStep(() => makePlan(task), {name: 'Plan'})
    //now that we have a plan we need to fire off an event the so the ui knows
    //think of events as a checkpoint
    await DBOS.runStep(
        () => emit({ 
            type: EventType.PlanCreated, 
            workflowId, 
            steps: plan.steps
        }),
        {name: "plan emit"}
    )

    //now we need to dispatch each agent with it's own context window to run the investigation
    const settled = await Promise.allSettled(plan.steps.map(s => {
      //for every step in this plan, I want to grab the step
      DBOS.runStep(async () => {
        await emit({
          type: EventType.SubagentStarted,
          workflowId,
          stepId: s.id,
          agent: s.agent,
          objective: s.objective
        });

        //ok cool, what are you findings mr investigator?
        const findings = await runInvestigator(s.agent, s.objective)
        //this emit is saying that the agent is done with it's investigation
        await emit({
          type: EventType.SubagentCompleted,
          workflowId,
          stepId: s.id,
          agent: s.agent,
          findings
        });
        return {agent: s.agent, findings}
        
      }), {name: `subagent-${s.id}`}
    })) 

    //grab all the findings of the settled ones and find the ones that failed and emit and that potentially failed
    const findings: { agent: string; findings: string }[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const step = plan.steps[i];
      if (result.status === "fulfilled") {
        findings.push(result.value);
      } else {
        await DBOS.runStep(
          () =>
            emit({
              type: EventType.SubagentFailed,
              workflowId,
              stepId: step.id,
              agent: step.agent,
              error: String(result.reason),
            }),
          { name: `subagent-failed-${step.id}` },
        );
      }
    }
    const reply = await DBOS.runStep(() => synthesize(task, findings), {name: 'synthesize'})

    //emit saying that the synthesis (summary) is completed
    await DBOS.runStep(() => 
      emit({
        type: EventType.ModelCompleted,
        workflowId,
        text: reply
      }),
      {name: "synth"}
    )

    return reply
}

export const runSupervisorWorkflow = DBOS.registerWorkflow(supervisorWorkflow, {
  name: 'supervisorWorkflow',
  
})