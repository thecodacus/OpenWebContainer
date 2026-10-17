/**
 * The source a `node -p <source>` run evaluates. Like node's -p, the expression runs in the global scope
 * (indirect eval) and its completion value is printed with console.log, so the shell and asynchronous
 * spawn paths agree on what -p prints.
 */
export function printEvalSource(source: string): string {
    return `console.log((0, eval)(${JSON.stringify(source)}));`;
}
