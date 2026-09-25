import vm from 'node:vm'

export type SandboxResult =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

export type SandboxApi = Record<string, (...args: any[]) => unknown>;

export async function runInSandbox(code: string, api: SandboxApi, options?: {timeoutMs?: number}) {
    const timeoutMs = options?.timeoutMs ?? 2000
    const logs: string[] = [] //logs array that takes in only strings

    const context = vm.createContext({
        tools: api, //tools we pass in, which is going to be a map of functions we can use
        console: {log: (...args: unknown[]) => { logs.push(args.map(String).join(' '))}}
        
    })

    //immediately invoked function
  // Wrapping code in an immediately invoked async function allows the code 
  // to use top-level async/await syntax. 
  // This makes it easier to run asynchronous operations without requiring the code to explicitly define an async function wrapper.

    const wrapped = `(async () => { ${code} })()`

    try {
        const pending = vm.runInContext(wrapped, context, {timeout: timeoutMs}) //the code we will be running in the VM
        const result = await withTimeout(pending, timeoutMs)
        return {
            ok: true,
            result,
            logs
        }
    } catch(e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message: String(e)
        }
    }
}

//helper function, returns whichever finishes first, the timeout or the code
//that is what Promise.race does
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`execution timed out after ${ms}ms`)), ms),
    ),
  ]);
}