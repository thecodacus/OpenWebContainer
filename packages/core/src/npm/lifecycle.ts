/** The lifecycle events npm runs for a package it installs, in run order. */
export const INSTALL_SCRIPT_EVENTS = ['preinstall', 'install', 'postinstall'] as const;

/** Characters that would need a shell (operators, expansion, globs, comments): a command using them is not run. */
const SHELL_SYNTAX = new Set(['&', '|', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '~', '#']);

/**
 * Node's arguments for a lifecycle command of the form `node <file>` or `node -e <code>`, or
 * undefined for any other command. The runtime has no shell, so a command that needs one is
 * not approximated: the caller skips it and says so.
 */
export function nodeArguments(command: string): string[] | undefined {
    const text = command.trim();
    if (!/^node\s/.test(text)) return undefined;
    const args: string[] = [];
    let token: string | undefined;
    let quote: '"' | "'" | undefined;
    for (let i = 'node'.length; i < text.length; i++) {
        const ch = text[i];
        if (quote === "'") {
            if (ch === "'") quote = undefined;
            else token = (token ?? '') + ch;
        } else if (quote === '"') {
            if (ch === '"') quote = undefined;
            else if (ch === '\\' && i + 1 < text.length && '"\\'.includes(text[i + 1])) token = (token ?? '') + text[++i];
            else if (ch === '$' || ch === '`') return undefined;
            else token = (token ?? '') + ch;
        } else if (ch === '\n' || ch === '\r') {
            return undefined;
        } else if (/\s/.test(ch)) {
            if (token !== undefined) {
                args.push(token);
                token = undefined;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            token = token ?? '';
        } else if (ch === '\\') {
            if (i + 1 >= text.length) return undefined;
            token = (token ?? '') + text[++i];
        } else if (SHELL_SYNTAX.has(ch)) {
            return undefined;
        } else {
            token = (token ?? '') + ch;
        }
    }
    if (quote !== undefined) return undefined;
    if (token !== undefined) args.push(token);
    return args.length > 0 ? args : undefined;
}
