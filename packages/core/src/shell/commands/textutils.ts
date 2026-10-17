/**
 * POSIX text-filter utilities for the OWC guest shell.
 *
 * Every command in this module is a synchronous handler: it reads through the virtual file system
 * handed to it, writes to the returned strings and never spawns a child. Behaviour follows POSIX
 * with the host's BSD utilities as the oracle; where BSD and GNU disagree the choice is recorded in
 * the manifest shipped alongside this file.
 *
 * Nothing outside this file is touched: every helper lives here.
 */
import { ShellCommand, CommandContext, CommandResult, atPath, inputText } from './types';

/* The usage line each of these commands prints when it is given nothing to do, named once so the
 * command and `man` (shell/commands/procinfo.ts) print the same text. */
const GREP_USAGE =
    'usage: grep [-abcdDEFGHhIiJLlMmnOopqRSsUVvwXxZz] [-A num] [-B num] [-C[num]]\n' +
    '\t[-e pattern] [-f file] [--binary-files=value] [--color=when]\n' +
    '\t[--context[=num]] [--directories=action] [--label] [--line-buffered]\n' +
    '\t[--null] [pattern] [file ...]\n';
const AWK_USAGE = "usage: awk [-F fs] [-v var=value] [-f progfile | 'prog'] [file ...]\n";
const CUT_USAGE = 'usage: cut -b list [-n] [file ...]\n       cut -c list [file ...]\n       cut -f list [-s] [-w | -d delim] [file ...]\n';
const TR_USAGE = 'usage: tr [-Ccsu] string1 string2\n       tr [-Ccu] -d string1\n       tr [-Ccu] -s string1\n       tr [-Ccu] -ds string1 string2\n';
const PASTE_USAGE = 'usage: paste [-s] [-d delimiters] file ...\n';
const COMM_USAGE = 'usage: comm [-123i] file1 file2\n';
const JOIN_USAGE = 'usage: join [-a fileno | -v fileno ] [-e string] [-1 field] [-2 field]\n' +
    '            [-o list] [-t char] file1 file2\n';
const DIFF_USAGE = [
    'usage: diff [-aBbdilpTtw] [-c | -e | -f | -n | -q | -u] [--ignore-case]',
    '            [--no-ignore-case] [--normal] [--strip-trailing-cr] [--tabsize]',
    '            [-I pattern] [-F pattern] [-L label] file1 file2',
    '       diff [-aBbdilpTtw] [-I pattern] [-L label] [--ignore-case]',
    '            [--no-ignore-case] [--normal] [--strip-trailing-cr] [--tabsize]',
    '            [-F pattern] -C number file1 file2',
    '       diff [-aBbdiltw] [-I pattern] [--ignore-case] [--no-ignore-case]',
    '            [--normal] [--strip-trailing-cr] [--tabsize] -D string file1 file2',
    '       diff [-aBbdilpTtw] [-I pattern] [-L label] [--ignore-case]',
    '            [--no-ignore-case] [--normal] [--tabsize] [--strip-trailing-cr]',
    '            [-F pattern] -U number file1 file2',
    '       diff [-aBbdilNPprsTtw] [-c | -e | -f | -n | -q | -u] [--ignore-case]',
    '            [--no-ignore-case] [--normal] [--tabsize] [-I pattern] [-L label]',
    '            [-F pattern] [-S name] [-X file] [-x pattern] dir1 dir2',
    '       diff [-aBbditwW] [--expand-tabs] [--ignore-all-blanks]',
    '            [--ignore-blank-lines] [--ignore-case] [--minimal]',
    '            [--no-ignore-file-name-case] [--strip-trailing-cr]',
    '            [--suppress-common-lines] [--tabsize] [--text] [--width]',
    '            -y | --side-by-side file1 file2',
    '       diff [--help] [--version]'
].join('\n') + '\n';

/** The usage lines this module publishes, by command name. `man` prints them as synopses. */
export const USAGE: Record<string, string> = {
    grep: GREP_USAGE,
    awk: AWK_USAGE,
    cut: CUT_USAGE,
    tr: TR_USAGE,
    paste: PASTE_USAGE,
    comm: COMM_USAGE,
    join: JOIN_USAGE,
    diff: DIFF_USAGE
};

/* ------------------------------------------------------------------ *
 * Result helpers
 * ------------------------------------------------------------------ */

function out(stdout: string): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}

function err(stderrText: string, code: number, stdoutText = ''): CommandResult {
    return { stdout: stdoutText, stderr: stderrText, exitCode: code };
}

function usage(name: string, stderrText: string): CommandResult {
    return err(`${name}: ${stderrText}\n`, 2);
}

/* ------------------------------------------------------------------ *
 * Line handling
 * ------------------------------------------------------------------ */

/**
 * Split a file's text into lines. A trailing newline produces no empty last line, so "a\n" is one
 * line; a final segment with no newline is still a line, so "a\nb" is two.
 */
function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Join lines back into text, always terminating the last line. */
function joinLines(lines: string[]): string {
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * File access
 * ------------------------------------------------------------------ */

interface NamedText {
    name: string;
    text: string;
}

function readOne(ctx: CommandContext, path: string): { text: string | undefined; isDir: boolean } {
    const full = atPath(ctx, path);
    let isDir = false;
    try {
        isDir = ctx.fs.isDirectory(full);
    } catch {
        isDir = false;
    }
    if (isDir) return { text: undefined, isDir: true };
    return { text: ctx.fs.readFile(full), isDir: false };
}

/** Recursively collect regular files below a directory, depth first and sorted. */
function walkDir(ctx: CommandContext, dir: string): string[] {
    const full = atPath(ctx, dir);
    const names = ctx.fs.readdirNames ? ctx.fs.readdirNames(full) : undefined;
    const list = names ?? safeListDirectory(ctx, full);
    const files: string[] = [];
    for (const name of (list ?? []).slice().sort()) {
        const child = (full === '/' ? '/' : full + '/') + name;
        if (ctx.fs.isDirectory(child)) {
            files.push(...walkDir(ctx, child));
        } else {
            files.push(child);
        }
    }
    return files;
}

function safeListDirectory(ctx: CommandContext, full: string): string[] {
    try {
        return ctx.fs.listDirectory(full).map((e) => (e.endsWith('/') ? e.slice(0, -1) : e));
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ *
 * POSIX regular expressions -> ECMAScript
 * ------------------------------------------------------------------ */

const POSIX_CLASSES: Record<string, string> = {
    alpha: 'A-Za-z',
    digit: '0-9',
    alnum: 'A-Za-z0-9',
    upper: 'A-Z',
    lower: 'a-z',
    space: ' \\t\\n\\r\\f\\v',
    blank: ' \\t',
    punct: '!-/:-@\\[-`{-~',
    print: ' -~',
    graph: '!-~',
    cntrl: '\\x00-\\x1f\\x7f',
    xdigit: '0-9A-Fa-f',
    word: 'A-Za-z0-9_',
};

function translateBracket(src: string, start: number): { text: string; next: number } {
    let i = start + 1;
    let text = '[';
    let first = true;
    while (i < src.length) {
        if (src[i] === ']') {
            if (first) {
                text += ']';
                i++;
                first = false;
                continue;
            }
            i++;
            break;
        }
        if (src.startsWith('[:', i)) {
            const end = src.indexOf(':]', i + 2);
            if (end !== -1) {
                const repl = POSIX_CLASSES[src.slice(i + 2, end)];
                if (repl !== undefined) {
                    text += repl;
                    i = end + 2;
                    first = false;
                    continue;
                }
            }
        }
        if (src[i] === '\\') {
            text += '\\' + (src[i + 1] ?? '\\');
            i += 2;
            first = false;
            continue;
        }
        text += src[i];
        i++;
        first = false;
    }
    return { text: text + ']', next: i };
}

function literalChar(c: string): string {
    return '^$.*+?()[]{}|\\'.indexOf(c) >= 0 ? '\\' + c : c;
}

/**
 * Translate a POSIX BRE (extended=false) or ERE (extended=true) into an ECMAScript pattern.
 * `anchorsAnywhere` selects the GNU reading where `^`/`$` are anchors wherever they appear; POSIX
 * says `^` is an anchor only at the start (BRE and ERE) and `$` only at the end of a BRE.
 */
function posixReToJs(pattern: string, extended: boolean, anchorsAnywhere = false): string {
    let outText = '';
    let i = 0;
    const n = pattern.length;
    while (i < n) {
        const c = pattern[i];
        if (c === '\\') {
            const d = pattern[i + 1];
            if (d === undefined) {
                outText += '\\\\';
                i++;
                continue;
            }
            if (d >= '1' && d <= '9') {
                outText += '\\' + d;
                i += 2;
                continue;
            }
            if (!extended && (d === '(' || d === ')')) {
                outText += d;
                i += 2;
                continue;
            }
            if (!extended && (d === '{' || d === '}')) {
                outText += d;
                i += 2;
                continue;
            }
            if (extended && (d === '{' || d === '}' || d === '|' || d === '+' || d === '?')) {
                outText += literalChar(d);
                i += 2;
                continue;
            }
            outText += literalChar(d);
            i += 2;
            continue;
        }
        if (c === '[') {
            const r = translateBracket(pattern, i);
            outText += r.text;
            i = r.next;
            continue;
        }
        if (c === '^') {
            outText += i === 0 || anchorsAnywhere ? '^' : '\\^';
            i++;
            continue;
        }
        if (c === '$') {
            const atEnd = i === n - 1;
            outText += extended || anchorsAnywhere || atEnd ? '$' : '\\$';
            i++;
            continue;
        }
        if (c === '.') {
            // `.` matches any character in a BRE and in an ERE alike; only `\.` is a literal dot.
            outText += '.';
            i++;
            continue;
        }
        if (c === '*') {
            if (!extended && i === 0) {
                outText += '\\*';
                i++;
                continue;
            }
            outText += '*';
            i++;
            continue;
        }
        if (extended) {
            if (c === '(' || c === ')' || c === '|' || c === '+' || c === '?') {
                outText += c;
                i++;
                continue;
            }
            if (c === '{') {
                const m = /^\{(\d+)(,(\d*)?)?\}/.exec(pattern.slice(i));
                if (m) {
                    outText += m[0];
                    i += m[0].length;
                    continue;
                }
                outText += '\\{';
                i++;
                continue;
            }
            if (c === '}') {
                outText += '\\}';
                i++;
                continue;
            }
            outText += literalChar(c);
            i++;
            continue;
        }
        outText += literalChar(c);
        i++;
    }
    return outText;
}

function escapeLiteral(pattern: string): string {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRe(
    pattern: string,
    opts: { extended?: boolean; ignoreCase?: boolean; fixed?: boolean; word?: boolean; line?: boolean }
): RegExp {
    let src: string;
    if (opts.fixed) {
        src = escapeLiteral(pattern);
    } else {
        src = posixReToJs(pattern, !!opts.extended);
    }
    if (opts.line) {
        src = '^(?:' + src + ')$';
    } else if (opts.word) {
        src = '(?<![A-Za-z0-9_])(?:' + src + ')(?![A-Za-z0-9_])';
    }
    let flags = 'g';
    if (opts.ignoreCase) flags += 'i';
    return new RegExp(src, flags);
}

/* ------------------------------------------------------------------ *
 * Argument scanning
 * ------------------------------------------------------------------ */

interface FlagSpec {
    /** Single letter flags that take no value. */
    plain: Set<string>;
    /** Single letter flags that consume the next word as their value. */
    valued: Set<string>;
}

/** Scan clustered short options; stops at the first non-option or at `--`. */
function scanFlags(
    args: string[],
    from: number,
    spec: FlagSpec
): { flags: string[]; values: Record<string, string[]>; operands: string[]; rest: string[] } {
    const flags: string[] = [];
    const values: Record<string, string[]> = {};
    const operands: string[] = [];
    let i = from;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg.length < 2 || arg[0] !== '-') break;
        const body = arg.slice(1);
        for (let j = 0; j < body.length; j++) {
            const ch = body[j];
            if (spec.valued.has(ch)) {
                let value: string;
                if (j + 1 < body.length) {
                    value = body.slice(j + 1);
                    j = body.length;
                } else {
                    value = args[i + 1] ?? '';
                    i++;
                }
                (values[ch] = values[ch] ?? []).push(value);
            } else if (spec.plain.has(ch)) {
                flags.push(ch);
            } else {
                // Unknown flag: keep it verbatim so the caller can report it.
                flags.push(ch);
                operands.push('-' + body.slice(j));
                j = body.length;
            }
        }
    }
    const rest = args.slice(i);
    for (const r of rest) operands.push(r);
    return { flags, values, operands, rest };
}

function hasFlag(flags: string[], ch: string): boolean {
    return flags.indexOf(ch) >= 0;
}

function lastValue(values: Record<string, string[]>, ch: string): string | undefined {
    const list = values[ch];
    return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function parseCount(text: string | undefined, fallback: number): number {
    if (text === undefined) return fallback;
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    if (/^[+-]\d+$/.test(text)) return parseInt(text, 10);
    return NaN;
}

/* ------------------------------------------------------------------ *
 * Byte-wise ordering (C locale)
 * ------------------------------------------------------------------ */

function utf8Bytes(s: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let cp = s.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                i++;
            }
        }
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return bytes;
}

/** Compare two strings bytewise in UTF-8, the C-locale ordering. */
function byteCompare(a: string, b: string): number {
    if (a === b) return 0;
    const x = utf8Bytes(a);
    const y = utf8Bytes(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
        if (x[i] !== y[i]) return x[i] - y[i];
    }
    return x.length - y.length;
}

function byteLength(s: string): number {
    return utf8Bytes(s).length;
}

/* ================================================================== *
 * grep
 * ================================================================== */

const GREP_PLAIN = new Set(['i', 'v', 'n', 'c', 'l', 'r', 'R', 'E', 'F', 'w', 'x', 'o', 'q', 's', 'H', 'h', 'b', 'a', 'I', 'Z', 'z']);
const GREP_VALUED = new Set(['e', 'f', 'A', 'B', 'C', 'm', 'd', 'D']);

const cmdGrep: ShellCommand = (ctx: CommandContext): CommandResult => {
    const scanned = scanFlags(ctx.args, 0, { plain: GREP_PLAIN, valued: GREP_VALUED });
    const flags = scanned.flags;
    const vals = scanned.values;
    const operands = scanned.operands;

    const patterns: string[] = [];
    for (const e of vals['e'] ?? []) patterns.push(e);
    for (const f of vals['f'] ?? []) {
        const p = atPath(ctx, f);
        const text = ctx.fs.readFile(p);
        if (text === undefined) {
            return err(`grep: ${f}: No such file or directory\n`, 2);
        }
        for (const line of splitLines(text)) patterns.push(line);
    }
    if (operands.length > 0 && patterns.length === 0) {
        patterns.push(operands[0]);
        operands.shift();
    }
    if (patterns.length === 0) {
        return err(
            GREP_USAGE,
            2
        );
    }

    const opts = {
        extended: hasFlag(flags, 'E'),
        fixed: hasFlag(flags, 'F'),
        ignoreCase: hasFlag(flags, 'i'),
        word: hasFlag(flags, 'w'),
        line: hasFlag(flags, 'x'),
    };
    const regexes: RegExp[] = [];
    for (const pattern of patterns) {
        try {
            regexes.push(compileRe(pattern, opts));
        } catch (e) {
            return err(`grep: ${(e as Error).message}\n`, 2);
        }
    }

    const invert = hasFlag(flags, 'v');
    const showNumbers = hasFlag(flags, 'n');
    const countOnly = hasFlag(flags, 'c');
    const namesOnly = hasFlag(flags, 'l');
    const onlyMatching = hasFlag(flags, 'o');
    const quiet = hasFlag(flags, 'q');
    const silent = hasFlag(flags, 's');
    const forceName = hasFlag(flags, 'H');
    const noName = hasFlag(flags, 'h');
    const before = parseCount(lastValue(vals, 'B'), 0);
    const after = parseCount(lastValue(vals, 'A'), 0);
    if (Number.isNaN(before) || Number.isNaN(after) || before < 0 || after < 0) {
        return err('grep: invalid context length argument\n', 2);
    }
    const context = before > 0 || after > 0;

    // Collect the sources: file operands (recursed when -r), or standard input.
    const sources: NamedText[] = [];
    const missing: string[] = [];
    let fileError = false;
    if (operands.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
    } else {
        for (const operand of operands) {
            if (operand === '-') {
                sources.push({ name: '-', text: ctx.input ?? '' });
                continue;
            }
            const info = readOne(ctx, operand);
            if (info.isDir) {
                if (hasFlag(flags, 'r') || hasFlag(flags, 'R')) {
                    const base = atPath(ctx, operand);
                    const prefix = operand.endsWith('/') ? operand : operand + '/';
                    for (const child of walkDir(ctx, operand)) {
                        const text = ctx.fs.readFile(child);
                        if (text === undefined) continue;
                        const relative = child.startsWith(base) ? child.slice(base.length).replace(/^\//, '') : child;
                        sources.push({ name: prefix + relative, text });
                    }
                } else if (!silent) {
                    missing.push(`grep: ${operand}: Is a directory`);
                    fileError = true;
                }
                continue;
            }
            if (info.text === undefined) {
                if (!silent) missing.push(`grep: ${operand}: No such file or directory`);
                fileError = true;
                continue;
            }
            sources.push({ name: operand, text: info.text });
        }
    }

    const prefixNames = !noName && (forceName || sources.length > 1);
    const stdoutChunks: string[] = [];
    let anyMatch = false;

    for (const source of sources) {
        const lines = splitLines(source.text);
        const label = source.name === '-' ? '(standard input)' : source.name;
        const prefix = prefixNames ? label + ':' : '';
        const numberPrefix = (index: number, isContext: boolean): string =>
            showNumbers ? (prefixNames ? label + ':' : '') + (index + 1) + (isContext ? '-' : ':') : prefix;

        if (countOnly) {
            let count = 0;
            for (const line of lines) {
                const hit = regexes.some((re) => {
                    re.lastIndex = 0;
                    return re.test(line);
                });
                if (invert ? !hit : hit) count++;
            }
            if (count > 0) anyMatch = true;
            stdoutChunks.push(prefix + count + '\n');
            continue;
        }

        const hits: boolean[] = lines.map((line) =>
            regexes.some((re) => {
                re.lastIndex = 0;
                return re.test(line);
            })
        );
        const selected = hits.map((h) => (invert ? !h : h));
        if (selected.some(Boolean)) anyMatch = true;

        if (namesOnly) {
            if (selected.some(Boolean)) stdoutChunks.push(label + '\n');
            continue;
        }
        if (quiet) {
            if (selected.some(Boolean)) return out('');
            continue;
        }

        let lastPrinted = -2;
        for (let k = 0; k < lines.length; k++) {
            if (!selected[k]) continue;
            if (onlyMatching) {
                if (invert) continue;
                const found: { start: number; text: string }[] = [];
                for (const re of regexes) {
                    re.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(lines[k])) !== null) {
                        if (m[0].length > 0) found.push({ start: m.index, text: m[0] });
                        if (m[0].length === 0) re.lastIndex++;
                    }
                }
                found.sort((a, b) => a.start - b.start);
                for (const f of found) stdoutChunks.push(numberPrefix(k, false) + f.text + '\n');
                continue;
            }
            if (context) {
                const start = Math.max(0, k - before);
                for (let j = start; j < k; j++) {
                    if (j <= lastPrinted) continue;
                    if (lastPrinted >= 0 && j > lastPrinted + 1) stdoutChunks.push('--\n');
                    stdoutChunks.push(numberPrefix(j, true) + lines[j] + '\n');
                    lastPrinted = j;
                }
                if (lastPrinted >= 0 && k > lastPrinted + 1) stdoutChunks.push('--\n');
                stdoutChunks.push(numberPrefix(k, false) + lines[k] + '\n');
                lastPrinted = k;
                const end = Math.min(lines.length - 1, k + after);
                for (let j = k + 1; j <= end; j++) {
                    stdoutChunks.push(numberPrefix(j, true) + lines[j] + '\n');
                    lastPrinted = j;
                }
                continue;
            }
            stdoutChunks.push(numberPrefix(k, false) + lines[k] + '\n');
        }
    }

    const finalExitCode = anyMatch ? 0 : 1;
    if (fileError) {
        if (!silent && missing.length > 0) return err(missing.join('\n') + '\n', 2, stdoutChunks.join(''));
        return { stdout: stdoutChunks.join(''), stderr: '', exitCode: 2 };
    }
    return { stdout: stdoutChunks.join(''), stderr: '', exitCode: quiet && !anyMatch ? 1 : finalExitCode };
};

/* ================================================================== *
 * sed
 * ================================================================== */

type SedAddr =
    | { kind: 'line'; n: number }
    | { kind: 'last' }
    | { kind: 're'; re: RegExp }
    | null;

interface SedCommand {
    addr1: SedAddr;
    addr2: SedAddr | null;
    negate: boolean;
    name: string;
    /** s: pattern, replacement, flags; y/a/i/c: payloads; {}: nested commands. */
    re?: RegExp;
    replacement?: string;
    flags?: string;
    text?: string;
    source?: string;
    target?: string;
    body?: SedCommand[];
}

class SedError extends Error {}

function sedUnescapeText(text: string): string {
    let outText = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && i + 1 < text.length) {
            const d = text[i + 1];
            if (d === 'n') {
                outText += '\n';
                i++;
                continue;
            }
            if (d === 't') {
                outText += '\t';
                i++;
                continue;
            }
            if (d === '\\') {
                outText += '\\';
                i++;
                continue;
            }
            outText += d;
            i++;
            continue;
        }
        outText += text[i];
    }
    return outText;
}

function sedParseAddr(
    script: string,
    i: number,
    extended: boolean
): { addr: SedAddr; next: number } | null {
    const n = script.length;
    let j = i;
    while (j < n && (script[j] === ' ' || script[j] === '\t')) j++;
    if (j >= n) return null;
    const c = script[j];
    if (c === '$') return { addr: { kind: 'last' }, next: j + 1 };
    if (c === '/' || c === '\\') {
        const delim = c === '/' ? '/' : script[j + 1];
        const start = c === '/' ? j + 1 : j + 2;
        let end = start;
        let text = '';
        while (end < n) {
            if (script[end] === '\\' && end + 1 < n) {
                text += script[end] + script[end + 1];
                end += 2;
                continue;
            }
            if (script[end] === delim) break;
            text += script[end];
            end++;
        }
        const src = posixReToJs(text, extended);
        let re: RegExp;
        try {
            re = new RegExp(src);
        } catch (e) {
            throw new SedError(`bad regexp: ${(e as Error).message}`);
        }
        return { addr: { kind: 're', re }, next: end + 1 };
    }
    if (c >= '0' && c <= '9') {
        let end = j;
        while (end < n && script[end] >= '0' && script[end] <= '9') end++;
        return { addr: { kind: 'line', n: parseInt(script.slice(j, end), 10) }, next: end };
    }
    return null;
}

function sedParseScript(script: string, extended: boolean): SedCommand[] {
    const commands: SedCommand[] = [];
    const n = script.length;
    let i = 0;
    while (i < n) {
        while (i < n && (script[i] === ' ' || script[i] === '\t' || script[i] === '\n' || script[i] === ';')) i++;
        if (i >= n) break;
        if (script[i] === '#') {
            while (i < n && script[i] !== '\n') i++;
            continue;
        }
        if (script[i] === '}') {
            i++;
            continue;
        }
        const first = sedParseAddr(script, i, extended);
        let addr1: SedAddr = null;
        let addr2: SedAddr | null = null;
        let j = i;
        if (first) {
            addr1 = first.addr;
            j = first.next;
            let k = j;
            while (k < n && (script[k] === ' ' || script[k] === '\t')) k++;
            if (script[k] === ',') {
                const second = sedParseAddr(script, k + 1, extended);
                if (!second) throw new SedError('expected context address');
                addr2 = second.addr;
                j = second.next;
            }
        }
        let negate = false;
        for (;;) {
            let k = j;
            while (k < n && (script[k] === ' ' || script[k] === '\t')) k++;
            if (script[k] === '!') {
                negate = !negate;
                j = k + 1;
                continue;
            }
            break;
        }
        while (j < n && (script[j] === ' ' || script[j] === '\t')) j++;
        if (j >= n) break;
        const name = script[j];
        const cmd: SedCommand = { addr1, addr2, negate, name };
        if (name === '{') {
            let depth = 1;
            let k = j + 1;
            while (k < n && depth > 0) {
                if (script[k] === '{') depth++;
                else if (script[k] === '}') depth--;
                if (depth === 0) break;
                k++;
            }
            cmd.body = sedParseScript(script.slice(j + 1, k), extended);
            commands.push(cmd);
            i = k + 1;
            continue;
        }
        if (name === 's') {
            const delim = script[j + 1];
            if (delim === undefined) throw new SedError('unterminated `s` command');
            const parts: string[] = [];
            let k = j + 2;
            let current = '';
            let done = false;
            while (k < n) {
                if (script[k] === '\\' && k + 1 < n) {
                    current += script[k] + script[k + 1];
                    k += 2;
                    continue;
                }
                if (script[k] === delim) {
                    parts.push(current);
                    current = '';
                    k++;
                    if (parts.length === 2) {
                        done = true;
                        break;
                    }
                    continue;
                }
                if (script[k] === '\n') break;
                current += script[k];
                k++;
            }
            if (!done) throw new SedError('unterminated `s` command');
            try {
                cmd.re = new RegExp(posixReToJs(parts[0], extended), 'g');
            } catch (e) {
                throw new SedError(`bad regexp: ${(e as Error).message}`);
            }
            cmd.replacement = parts[1];
            let flags = '';
            while (k < n && script[k] !== ';' && script[k] !== '\n' && script[k] !== '#' && script[k] !== '}') {
                flags += script[k];
                k++;
            }
            cmd.flags = flags.trim();
            commands.push(cmd);
            i = k;
            continue;
        }
        if (name === 'y') {
            const delim = script[j + 1];
            const parts: string[] = [];
            let k = j + 2;
            let current = '';
            while (k < n && parts.length < 2) {
                if (script[k] === '\\' && k + 1 < n) {
                    current += script[k] + script[k + 1];
                    k += 2;
                    continue;
                }
                if (script[k] === delim) {
                    parts.push(current);
                    current = '';
                    k++;
                    continue;
                }
                current += script[k];
                k++;
            }
            cmd.source = sedUnescapeText(parts[0] ?? '');
            cmd.target = sedUnescapeText(parts[1] ?? '');
            commands.push(cmd);
            i = k;
            continue;
        }
        if (name === 'a' || name === 'i' || name === 'c') {
            let k = j + 1;
            while (k < n && (script[k] === ' ' || script[k] === '\t')) k++;
            if (script[k] !== '\\') {
                throw new SedError(`command ${name} expects \\ followed by text`);
            }
            k++;
            let rest = '';
            while (k < n && script[k] !== '\n') {
                rest += script[k];
                k++;
            }
            if (rest.trim() !== '') {
                throw new SedError(`extra characters after \\ at the end of ${name} command`);
            }
            k++;
            let text = '';
            while (k < n && script[k] !== '\n') {
                text += script[k];
                k++;
            }
            cmd.text = text;
            commands.push(cmd);
            i = k;
            continue;
        }
        if (name === ':') {
            let k = j + 1;
            while (k < n && script[k] !== ';' && script[k] !== '\n' && script[k] !== '}') k++;
            i = k;
            continue;
        }
        if ('dDpPgGhHx=lqQzFnN'.indexOf(name) >= 0) {
            let k2 = j + 1;
            while (k2 < n && (script[k2] === ' ' || script[k2] === '\t')) k2++;
            if (k2 < n && script[k2] !== ';' && script[k2] !== '\n' && script[k2] !== '#' && script[k2] !== '}') {
                throw new SedError(`extra characters at the end of ${name} command`);
            }
        }
        commands.push(cmd);
        i = j + 1;
        while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== '#') i++;
        if (i < n && script[i] === '#') {
            while (i < n && script[i] !== '\n') i++;
        }
    }
    return commands;
}

function sedMatchesAddr(addr: SedAddr, lineNumber: number, pattern: string, lastLine: boolean): boolean {
    if (addr === null) return true;
    if (addr.kind === 'line') return lineNumber === addr.n;
    if (addr.kind === 'last') return lastLine;
    addr.re.lastIndex = 0;
    return addr.re.test(pattern);
}

function sedExpand(replacement: string, match: RegExpExecArray, delim: string): string {
    let outText = '';
    for (let i = 0; i < replacement.length; i++) {
        const c = replacement[i];
        if (c === '\\' && i + 1 < replacement.length) {
            const d = replacement[i + 1];
            if (d >= '0' && d <= '9') {
                const group = match[parseInt(d, 10)];
                outText += group === undefined ? '' : group;
                i++;
                continue;
            }
            if (d === 'n') {
                outText += '\n';
                i++;
                continue;
            }
            outText += d;
            i++;
            continue;
        }
        if (c === '&') {
            outText += match[0];
            continue;
        }
        outText += c;
    }
    void delim;
    return outText;
}

interface SedStream {
    lines: string[];
    write: (text: string) => void;
}

function sedApply(
    commands: SedCommand[],
    ctxLines: string[],
    emit: (text: string) => void,
    autoPrintDefault: boolean,
    inRange: (id: number) => boolean,
    setRange: (id: number, value: boolean) => void,
    rangeIds: Map<SedCommand, number>,
    unterminatedLast: boolean
): void {
    let lineNumber = 0;
    let quit = false;
    let deleted = false;
    let skipPrint = false;
    const lastIndex = ctxLines.length - 1;
    /** A final line with no newline in the input is written back with no newline either. */
    const terminator = (index: number): string => index === lastIndex && unterminatedLast ? '' : '\n';
    for (let index = 0; index < ctxLines.length && !quit; index++) {
        lineNumber++;
        let pattern = ctxLines[index];
        const lastLine = index === ctxLines.length - 1;
        let autoPrint = autoPrintDefault;
        deleted = false;
        skipPrint = false;
        const appended: string[] = [];

        const run = (list: SedCommand[]): void => {
            for (const cmd of list) {
                const id = rangeIds.get(cmd) ?? -1;
                let active: boolean;
                if (cmd.addr2 !== null) {
                    const inR = id >= 0 && inRange(id);
                    if (!inR) {
                        if (sedMatchesAddr(cmd.addr1, lineNumber, pattern, lastLine)) {
                            if (cmd.addr2.kind === 'line' && cmd.addr2.n <= lineNumber) {
                                active = true;
                            } else if (cmd.addr2.kind === 're' || cmd.addr2.kind === 'last') {
                                active = true;
                                if (id >= 0) setRange(id, true);
                            } else {
                                active = true;
                                if (id >= 0) setRange(id, true);
                            }
                        } else {
                            active = false;
                        }
                    } else {
                        active = true;
                        const end =
                            cmd.addr2.kind === 'line'
                                ? lineNumber >= cmd.addr2.n
                                : cmd.addr2.kind === 'last'
                                  ? lastLine
                                  : sedMatchesAddr(cmd.addr2, lineNumber, pattern, lastLine);
                        if (end && id >= 0) setRange(id, false);
                    }
                } else {
                    active = sedMatchesAddr(cmd.addr1, lineNumber, pattern, lastLine);
                }
                if (cmd.negate) active = !active;
                if (!active) continue;

                switch (cmd.name) {
                    case 'p':
                        emit(pattern + '\n');
                        break;
                    case 'P':
                        emit(pattern.split('\n')[0] + '\n');
                        break;
                    case 'd':
                        deleted = true;
                        return;
                    case 'D': {
                        const nl = pattern.indexOf('\n');
                        if (nl >= 0) {
                            pattern = pattern.slice(nl + 1);
                            index--;
                            lineNumber--;
                            skipPrint = true;
                            return;
                        }
                        deleted = true;
                        return;
                    }
                    case 'q':
                        quit = true;
                        return;
                    case '=':
                        emit(lineNumber + '\n');
                        break;
                    case 'i':
                        emit((cmd.text ?? '') + '\n');
                        break;
                    case 'a':
                        appended.push((cmd.text ?? '') + '\n');
                        break;
                    case 'c': {
                        deleted = true;
                        if (cmd.addr2 !== null) {
                            if (!(id >= 0 && inRange(id))) emit((cmd.text ?? '') + '\n');
                        } else {
                            emit((cmd.text ?? '') + '\n');
                        }
                        return;
                    }
                    case 'l':
                        emit(pattern.replace(/\\/g, '\\\\').replace(/\t/g, '\\t') + '$\n');
                        break;
                    case 's': {
                        const re = cmd.re as RegExp;
                        re.lastIndex = 0;
                        const flags = cmd.flags ?? '';
                        const global = flags.indexOf('g') >= 0;
                        const numMatch = /([1-9])/.exec(flags);
                        const which = numMatch ? parseInt(numMatch[1], 10) : 0;
                        let result = '';
                        let last = 0;
                        let count = 0;
                        let changed = false;
                        let m: RegExpExecArray | null;
                        while ((m = re.exec(pattern)) !== null) {
                            count++;
                            const doReplace = which === 0 ? true : global ? count >= which : count === which;
                            if (doReplace) {
                                result += pattern.slice(last, m.index) + sedExpand(cmd.replacement ?? '', m, '');
                                last = m.index + m[0].length;
                                changed = true;
                                if (!global) break;
                            } else if (!global && count > which) {
                                break;
                            }
                            if (m[0].length === 0) {
                                re.lastIndex++;
                                if (re.lastIndex > pattern.length) break;
                            }
                        }
                        if (!changed) result = pattern;
                        else result += pattern.slice(last);
                        pattern = result;
                        if (changed && flags.indexOf('p') >= 0) emit(pattern + '\n');
                        break;
                    }
                    case 'y': {
                        const src = cmd.source ?? '';
                        const dst = cmd.target ?? '';
                        let result = '';
                        for (const ch of pattern) {
                            const at = src.indexOf(ch);
                            result += at >= 0 && at < dst.length ? dst[at] : ch;
                        }
                        pattern = result;
                        break;
                    }
                    case 'n': {
                        if (autoPrint) emit(pattern + '\n');
                        autoPrint = autoPrintDefault;
                        if (index + 1 < ctxLines.length) {
                            index++;
                            lineNumber++;
                            pattern = ctxLines[index];
                        } else {
                            quit = true;
                            deleted = true;
                            return;
                        }
                        break;
                    }
                    case '{':
                        run(cmd.body ?? []);
                        if (deleted) return;
                        break;
                    default:
                        break;
                }
            }
        };

        run(commands);
        if (quit) {
            if (autoPrint && !deleted && !skipPrint) emit(pattern + terminator(index));
            break;
        }
        if (autoPrint && !deleted && !skipPrint) emit(pattern + terminator(index));
        for (const text of appended) emit(text);
    }
}

function sedMakeRangeIds(commands: SedCommand[], map: Map<SedCommand, number>, counter: { n: number }): void {
    for (const cmd of commands) {
        if (cmd.addr2 !== null) map.set(cmd, counter.n++);
        if (cmd.body) sedMakeRangeIds(cmd.body, map, counter);
    }
}

const SED_PLAIN = new Set(['n', 'E', 'r', 's', 'u', 'l', 'a']);
const SED_VALUED = new Set(['e', 'f', 'i']);

const cmdSed: ShellCommand = (ctx: CommandContext): CommandResult => {
    const args = ctx.args;
    const scripts: string[] = [];
    const files: string[] = [];
    let noPrint = false;
    let extended = false;
    let inPlace = false;
    let suffix: string | null = null;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg === '-') {
            files.push('-');
            continue;
        }
        if (arg.length > 1 && arg[0] === '-') {
            const body = arg.slice(1);
            let j = 0;
            for (; j < body.length; j++) {
                const ch = body[j];
                if (ch === 'n') {
                    noPrint = true;
                    continue;
                }
                if (ch === 'E' || ch === 'r') {
                    extended = true;
                    continue;
                }
                if (ch === 's') {
                    // -s: treat files separately (accepted, no separate streams here)
                    continue;
                }
                if (ch === 'u' || ch === 'l' || ch === 'a') continue;
                if (ch === 'e') {
                    const value = j + 1 < body.length ? body.slice(j + 1) : args[++i] ?? '';
                    scripts.push(value);
                    j = body.length;
                    continue;
                }
                if (ch === 'f') {
                    const value = j + 1 < body.length ? body.slice(j + 1) : args[++i] ?? '';
                    const full = atPath(ctx, value);
                    const text = ctx.fs.readFile(full);
                    if (text === undefined) return err(`sed: ${value}: No such file or directory\n`, 1);
                    scripts.push(text);
                    j = body.length;
                    continue;
                }
                if (ch === 'i') {
                    inPlace = true;
                    if (j + 1 < body.length) {
                        suffix = body.slice(j + 1);
                        j = body.length;
                    } else if (i + 1 < args.length && (args[i + 1] === '' || args[i + 1][0] !== '-')) {
                        suffix = args[++i];
                    } else {
                        suffix = '';
                    }
                    continue;
                }
                return err(`sed: illegal option -- ${ch}\n`, 1);
            }
            continue;
        }
        break;
    }
    for (; i < args.length; i++) files.push(args[i]);

    if (scripts.length === 0) {
        if (files.length === 0) {
            // No script and no operands: BSD sed accepts this and simply copies its standard input.
            return out(ctx.input ?? '');
        }
        scripts.push(files[0]);
        files.shift();
    }

    let commands: SedCommand[];
    try {
        commands = [];
        for (const script of scripts) commands = commands.concat(sedParseScript(script, extended));
    } catch (e) {
        return err(`sed: ${(e as Error).message}\n`, 1);
    }

    const rangeIds = new Map<SedCommand, number>();
    sedMakeRangeIds(commands, rangeIds, { n: 0 });

    const runOnLines = (lines: string[], unterminatedLast: boolean): string => {
        const rangeState: boolean[] = [];
        let buffer = '';
        sedApply(
            commands,
            lines,
            (text) => {
                buffer += text;
            },
            !noPrint,
            (id) => rangeState[id] === true,
            (id, value) => {
                rangeState[id] = value;
            },
            rangeIds,
            unterminatedLast
        );
        return buffer;
    };

    if (files.length === 0) {
        const text = ctx.input ?? '';
        return out(runOnLines(splitLines(text), text !== '' && !text.endsWith('\n')));
    }

    let stdoutText = '';
    for (const file of files) {
        const info = readOne(ctx, file);
        if (info.text === undefined) {
            return err(`sed: ${file}: No such file or directory\n`, 1);
        }
        const produced = runOnLines(
            splitLines(info.text),
            info.text !== '' && !info.text.endsWith('\n')
        );
        if (inPlace) {
            const target = atPath(ctx, file) + (suffix ?? '');
            ctx.fs.writeFile(target, produced);
        } else {
            stdoutText += produced;
        }
    }
    return out(stdoutText);
};

/* ================================================================== *
 * awk
 * ================================================================== */

const V_NUM = 0;
const V_STRNUM = 1;
const V_STRING = 2;
const V_UNINIT = 3;

interface AwkVal {
    t: number;
    n: number;
    s: string;
}

function num(n: number): AwkVal {
    return { t: V_NUM, n, s: '' };
}
function str(s: string): AwkVal {
    return { t: V_STRING, n: 0, s };
}
function strnum(s: string, n: number): AwkVal {
    return { t: V_STRNUM, n, s };
}
function uninit(): AwkVal {
    return { t: V_UNINIT, n: 0, s: '' };
}

function looksNumeric(s: string): number | null {
    const t = s.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
    if (t === '') return null;
    if (/^([+-]?)((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(t)) {
        const v = parseFloat(t);
        if (Number.isFinite(v)) return v;
    }
    if (/^[+-]?(inf|infinity)$/i.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(t)) return NaN;
    return null;
}

function awkToNum(v: AwkVal): number {
    if (v.t === V_NUM || v.t === V_STRNUM) return v.n;
    if (v.t === V_UNINIT) return 0;
    const t = v.s.replace(/^[ \t\n]+/, '');
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(t);
    if (m) return parseFloat(m[1]);
    return 0;
}

function numToString(n: number, convfmt: string): string {
    if (Number.isNaN(n)) return 'nan';
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
    return sprintfFormat(convfmt, [num(n)]);
}

function awkToStr(v: AwkVal, convfmt: string): string {
    if (v.t === V_STRING || v.t === V_STRNUM) return v.s;
    if (v.t === V_UNINIT) return '';
    return numToString(v.n, convfmt);
}

function awkTruthy(v: AwkVal): boolean {
    if (v.t === V_NUM) return v.n !== 0;
    if (v.t === V_UNINIT) return false;
    if (v.t === V_STRNUM) return v.n !== 0;
    return v.s !== '';
}

function awkCompare(a: AwkVal, b: AwkVal): number {
    const numeric = a.t !== V_STRING && b.t !== V_STRING && (a.t <= V_STRNUM || b.t <= V_STRNUM);
    if (numeric) {
        const x = awkToNum(a);
        const y = awkToNum(b);
        if (Number.isNaN(x) || Number.isNaN(y)) return -1;
        if (x === y) return 0;
        return x < y ? -1 : 1;
    }
    return byteCompare(awkToStr(a, '%.6g'), awkToStr(b, '%.6g'));
}

/* ---- tokenizer ---- */

type TokKind = 'num' | 'str' | 're' | 'id' | 'op' | 'eof';

interface Tok {
    kind: TokKind;
    text: string;
    n?: number;
    re?: RegExp;
}

const AWK_ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '^='];

const AWK_KEYWORDS = new Set([
    'BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue',
    'next', 'nextfile', 'exit', 'return', 'delete', 'print', 'printf', 'in', 'getline',
]);

function awkTokenize(src: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    const n = src.length;
    const prevSignificant = (): Tok | undefined => {
        for (let k = toks.length - 1; k >= 0; k--) {
            if (toks[k].kind === 'op' && (toks[k].text === '\n' || toks[k].text === ';')) continue;
            return toks[k];
        }
        return undefined;
    };
    const endsOperand = (tok: Tok): boolean => {
        if (tok.kind === 'num' || tok.kind === 'str' || tok.kind === 're') return true;
        if (tok.kind === 'id') return !AWK_KEYWORDS.has(tok.text);
        if (tok.kind === 'op') return [')', ']', '++', '--'].indexOf(tok.text) >= 0;
        return false;
    };
    const operandExpected = (): boolean => {
        const p = prevSignificant();
        return p === undefined ? true : !endsOperand(p);
    };
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r') {
            i++;
            continue;
        }
        if (c === '\\' && src[i + 1] === '\n') {
            i += 2;
            continue;
        }
        if (c === '\n' || c === ';') {
            toks.push({ kind: 'op', text: c });
            i++;
            continue;
        }
        if (c === '#') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && operandExpected()) {
            let j = i + 1;
            let body = '';
            while (j < n && src[j] !== '/') {
                if (src[j] === '\\' && j + 1 < n) {
                    body += src[j] + src[j + 1];
                    j += 2;
                    continue;
                }
                body += src[j];
                j++;
            }
            toks.push({ kind: 're', text: '/' + body + '/', re: new RegExp(posixReToJs(body, true)) });
            i = j + 1;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            let body = '';
            while (j < n && src[j] !== '"') {
                if (src[j] === '\\' && j + 1 < n) {
                    const d = src[j + 1];
                    body +=
                        d === 'n' ? '\n' : d === 't' ? '\t' : d === 'r' ? '\r' : d === '\\' ? '\\' : d === '"' ? '"' : d;
                    j += 2;
                    continue;
                }
                body += src[j];
                j++;
            }
            toks.push({ kind: 'str', text: body });
            i = j + 1;
            continue;
        }
        if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            const m = /^(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
            const text = m ? m[1] : c;
            toks.push({ kind: 'num', text, n: parseFloat(text) });
            i += text.length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
            toks.push({ kind: 'id', text: src.slice(i, j) });
            i = j;
            continue;
        }
        const three = src.slice(i, i + 3);
        if (['**=', '...'].indexOf(three) >= 0) {
            toks.push({ kind: 'op', text: three });
            i += 3;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (
            [
                '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '&&', '||', '++', '--',
                '>>', '~', '!~', '**',
            ].indexOf(two) >= 0
        ) {
            toks.push({ kind: 'op', text: two });
            i += 2;
            continue;
        }
        if ('+-*/%<>!?:,(){}[]=;&|~$'.indexOf(c) >= 0) {
            toks.push({ kind: 'op', text: c });
            i++;
            continue;
        }
        i++;
    }
    toks.push({ kind: 'op', text: '' , });
    return toks;
}

/* ---- AST ---- */

type AwkNode = { k: string; [key: string]: any };

/* ---- parser ---- */

class AwkParseError extends Error {}

class AwkParser {
    private toks: Tok[];
    private pos = 0;
    constructor(toks: Tok[]) {
        this.toks = toks;
    }
    private peek(): Tok {
        return this.toks[this.pos];
    }
    private at(text: string): boolean {
        const t = this.peek();
        return t.kind === 'op' && t.text === text;
    }
    private atId(text: string): boolean {
        const t = this.peek();
        return t.kind === 'id' && t.text === text;
    }
    private eat(text: string): boolean {
        if (this.at(text)) {
            this.pos++;
            return true;
        }
        return false;
    }
    private expect(text: string): void {
        if (!this.eat(text)) throw new AwkParseError(`expected ${text}`);
    }
    private skipSeparators(): void {
        while (this.peek().kind === 'op' && (this.peek().text === ';' || this.peek().text === '\n')) this.pos++;
    }

    parseProgram(): AwkNode[] {
        const items: AwkNode[] = [];
        this.skipSeparators();
        while (!(this.peek().kind === 'op' && this.peek().text === '')) {
            items.push(this.parseItem());
            this.skipSeparators();
        }
        return items;
    }

    private parseItem(): AwkNode {
        if (this.atId('function') || this.atId('func')) {
            this.pos++;
            const name = this.peek().text;
            this.pos++;
            this.expect('(');
            const params: string[] = [];
            if (!this.at(')')) {
                for (;;) {
                    params.push(this.peek().text);
                    this.pos++;
                    if (this.eat(',')) continue;
                    break;
                }
            }
            this.expect(')');
            this.skipSeparators();
            const body = this.parseBlock();
            return { k: 'func', name, params, body };
        }
        let begin: string | null = null;
        if (this.atId('BEGIN')) {
            this.pos++;
            begin = 'BEGIN';
        } else if (this.atId('END')) {
            this.pos++;
            begin = 'END';
        }
        this.skipSeparators();
        if (this.at('{')) {
            const body = this.parseBlock();
            return { k: 'rule', begin, pattern: null, body };
        }
        const pattern = this.parseExpr(false);
        let end: AwkNode | null = null;
        if (this.eat(',')) {
            this.skipSeparators();
            end = this.parseExpr(false);
        }
        this.skipSeparators();
        if (this.at('{')) {
            const body = this.parseBlock();
            return { k: 'rule', begin, pattern, end, body };
        }
        return { k: 'rule', begin, pattern, end, body: null };
    }

    private parseBlock(): AwkNode[] {
        this.expect('{');
        const stmts: AwkNode[] = [];
        this.skipSeparators();
        while (!this.at('}')) {
            if (this.peek().kind === 'op' && this.peek().text === '') throw new AwkParseError('unterminated block');
            stmts.push(this.parseStmt());
            this.skipSeparators();
        }
        this.expect('}');
        return stmts;
    }

    private parseSimple(): AwkNode {
        if (this.at('{')) return { k: 'block', body: this.parseBlock() };
        if (this.atId('if')) {
            this.pos++;
            this.expect('(');
            const cond = this.parseExpr(true);
            this.expect(')');
            this.skipSeparators();
            const then = this.parseSimpleOrSemi();
            this.skipSeparators();
            let other: AwkNode | null = null;
            if (this.atId('else')) {
                this.pos++;
                this.skipSeparators();
                other = this.parseSimpleOrSemi();
            }
            return { k: 'if', cond, then, other };
        }
        if (this.atId('while')) {
            this.pos++;
            this.expect('(');
            const cond = this.parseExpr(true);
            this.expect(')');
            this.skipSeparators();
            const body = this.parseSimpleOrSemi();
            return { k: 'while', cond, body };
        }
        if (this.atId('do')) {
            this.pos++;
            this.skipSeparators();
            const body = this.parseSimpleOrSemi();
            this.skipSeparators();
            if (!this.atId('while')) throw new AwkParseError('expected while');
            this.pos++;
            this.expect('(');
            const cond = this.parseExpr(true);
            this.expect(')');
            return { k: 'do', cond, body };
        }
        if (this.atId('for')) {
            this.pos++;
            this.expect('(');
            if (this.peek().kind === 'id' && this.toks[this.pos + 1]?.kind === 'id' && this.toks[this.pos + 1].text === 'in') {
                const name = this.peek().text;
                this.pos += 2;
                const arr = this.parseExpr(false);
                this.expect(')');
                this.skipSeparators();
                const body = this.parseSimpleOrSemi();
                return { k: 'forin', name, arr, body };
            }
            const init = this.at(';') ? null : this.parseSimpleNoStruct();
            this.expect(';');
            this.skipSeparators();
            const cond = this.at(';') ? null : this.parseExpr(true);
            this.expect(';');
            this.skipSeparators();
            const incr = this.at(')') ? null : this.parseSimpleNoStruct();
            this.expect(')');
            this.skipSeparators();
            const body = this.parseSimpleOrSemi();
            return { k: 'for', init, cond, incr, body };
        }
        if (this.atId('print') || this.atId('printf')) {
            const isPrintf = this.peek().text === 'printf';
            this.pos++;
            const args: AwkNode[] = [];
            if (this.parseExprStart()) {
                args.push(this.parseExpr(false));
                while (this.eat(',')) {
                    this.skipSeparators();
                    args.push(this.parseExpr(false));
                }
            }
            let redirect: AwkNode | null = null;
            let append = false;
            if (this.at('>') || this.at('>>')) {
                append = this.peek().text === '>>';
                this.pos++;
                redirect = this.parseExpr(false);
            }
            return { k: isPrintf ? 'printf' : 'print', args, redirect, append };
        }
        if (this.atId('next') || this.atId('nextfile')) {
            this.pos++;
            return { k: 'next' };
        }
        if (this.atId('exit')) {
            this.pos++;
            const value = this.parseExprStart() ? this.parseExpr(false) : null;
            return { k: 'exit', value };
        }
        if (this.atId('return')) {
            this.pos++;
            const value = this.parseExprStart() ? this.parseExpr(false) : null;
            return { k: 'return', value };
        }
        if (this.atId('break')) {
            this.pos++;
            return { k: 'break' };
        }
        if (this.atId('continue')) {
            this.pos++;
            return { k: 'continue' };
        }
        if (this.atId('delete')) {
            this.pos++;
            const target = this.parseExpr(false);
            return { k: 'delete', target };
        }
        return { k: 'expr', expr: this.parseExpr(true) };
    }

    private parseSimpleOrSemi(): AwkNode {
        const s = this.parseSimple();
        this.eat(';');
        return s;
    }

    private parseSimpleNoStruct(): AwkNode {
        return { k: 'expr', expr: this.parseExpr(true) };
    }

    private parseStmt(): AwkNode {
        return this.parseSimpleOrSemi();
    }

    private parseExprStart(): boolean {
        const t = this.peek();
        if (t.kind === 'op' && (t.text === '' || t.text === '}' || t.text === ')' || t.text === ';' || t.text === '\n' || t.text === '>' || t.text === '>>')) return false;
        if (t.kind === 'id' && (t.text === 'in' || t.text === 'print' || t.text === 'printf')) return false;
        return true;
    }

    private parseExpr(top: boolean): AwkNode {
        const left = this.parseTernary(top);
        const t = this.peek();
        if (t.kind === 'op' && AWK_ASSIGN_OPS.indexOf(t.text) >= 0) {
            if (left.k === 'var' || left.k === 'field' || left.k === 'index') {
                this.pos++;
                this.skipSeparators();
                const right = this.parseExpr(false);
                return { k: 'assign', op: t.text, target: left, value: right };
            }
        }
        return left;
    }

    private parseTernary(top: boolean): AwkNode {
        const cond = this.parseOr(top);
        if (this.at('?')) {
            this.pos++;
            this.skipSeparators();
            const a = this.parseTernary(false);
            this.expect(':');
            this.skipSeparators();
            const b = this.parseTernary(false);
            return { k: 'ternary', cond, a, b };
        }
        return cond;
    }

    private parseOr(top: boolean): AwkNode {
        let left = this.parseAnd(top);
        while (this.at('||')) {
            this.pos++;
            this.skipSeparators();
            const right = this.parseAnd(top);
            left = { k: 'bin', op: '||', left, right };
        }
        return left;
    }

    private parseAnd(top: boolean): AwkNode {
        let left = this.parseIn(top);
        while (this.at('&&')) {
            this.pos++;
            this.skipSeparators();
            const right = this.parseIn(top);
            left = { k: 'bin', op: '&&', left, right };
        }
        return left;
    }

    private parseIn(top: boolean): AwkNode {
        const left = this.parseCompare(top);
        if (this.atId('in')) {
            this.pos++;
            const right = this.parseExpr(false);
            return { k: 'in', left, right };
        }
        return left;
    }

    private parseCompare(top: boolean): AwkNode {
        let left = this.parseConcat(top);
        for (;;) {
            const t = this.peek();
            if (t.kind === 'op' && ['==', '!=', '<', '<=', '>', '>=', '~', '!~'].indexOf(t.text) >= 0) {
                this.pos++;
                this.skipSeparators();
                const right = this.parseConcat(top);
                left = { k: 'bin', op: t.text, left, right };
                continue;
            }
            return left;
        }
    }

    private parseConcat(top: boolean): AwkNode {
        let left = this.parseAdditive(top);
        for (;;) {
            if (this.parseConcatOperandStarts()) {
                const right = this.parseAdditive(top);
                left = { k: 'concat', left, right };
                continue;
            }
            return left;
        }
    }

    private parseConcatOperandStarts(): boolean {
        const t = this.peek();
        if (t.kind === 'str' || t.kind === 'num' || t.kind === 're') return true;
        if (t.kind === 'id') return !AWK_KEYWORDS.has(t.text);
        if (t.kind === 'op') return t.text === '$' || t.text === '(' || t.text === '!' || t.text === '+' || t.text === '-' || t.text === '++' || t.text === '--';
        return false;
    }

    private parseAdditive(top: boolean): AwkNode {
        let left = this.parseMultiplicative(top);
        for (;;) {
            const t = this.peek();
            if (t.kind === 'op' && (t.text === '+' || t.text === '-')) {
                this.pos++;
                this.skipSeparators();
                const right = this.parseMultiplicative(top);
                left = { k: 'bin', op: t.text, left, right };
                continue;
            }
            return left;
        }
    }

    private parseMultiplicative(top: boolean): AwkNode {
        let left = this.parseUnary(top);
        for (;;) {
            const t = this.peek();
            if (t.kind === 'op' && ['*', '/', '%'].indexOf(t.text) >= 0) {
                this.pos++;
                this.skipSeparators();
                const right = this.parseUnary(top);
                left = { k: 'bin', op: t.text, left, right };
                continue;
            }
            return left;
        }
    }

    private parseUnary(top: boolean): AwkNode {
        if (this.at('!')) {
            this.pos++;
            return { k: 'unary', op: '!', operand: this.parseUnary(top) };
        }
        if (this.at('-')) {
            this.pos++;
            return { k: 'unary', op: '-', operand: this.parseUnary(top) };
        }
        if (this.at('+')) {
            this.pos++;
            return { k: 'unary', op: '+', operand: this.parseUnary(top) };
        }
        return this.parsePower(top);
    }

    private parsePower(top: boolean): AwkNode {
        const base = this.parsePostfix(top);
        if (this.at('^') || this.at('**')) {
            this.pos++;
            this.skipSeparators();
            return { k: 'bin', op: '^', left: base, right: this.parseUnary(top) };
        }
        return base;
    }

    private parsePostfix(top: boolean): AwkNode {
        const t = this.peek();
        if (t.kind === 'op' && (t.text === '++' || t.text === '--')) {
            this.pos++;
            const operand = this.parsePostfix(top);
            return { k: 'pre', op: t.text, operand };
        }
        let node = this.parsePrimary(top);
        for (;;) {
            if (this.at('++') || this.at('--')) {
                const op = this.peek().text;
                this.pos++;
                node = { k: 'post', op, operand: node };
                continue;
            }
            if (this.at('[')) {
                this.pos++;
                const index = this.parseExpr(true);
                this.expect(']');
                node = { k: 'index', arr: node, index };
                continue;
            }
            if (this.at('(')) {
                this.pos++;
                const args: AwkNode[] = [];
                this.skipSeparators();
                if (!this.at(')')) {
                    args.push(this.parseExpr(false));
                    while (this.eat(',')) {
                        this.skipSeparators();
                        args.push(this.parseExpr(false));
                    }
                }
                this.expect(')');
                node = { k: 'call', callee: node, args };
                continue;
            }
            return node;
        }
    }

    private parsePrimary(top: boolean): AwkNode {
        const t = this.peek();
        if (t.kind === 'num') {
            this.pos++;
            return { k: 'lit', value: num(t.n ?? 0) };
        }
        if (t.kind === 'str') {
            this.pos++;
            return { k: 'lit', value: str(t.text) };
        }
        if (t.kind === 're') {
            this.pos++;
            return { k: 'regex', re: t.re as RegExp };
        }
        if (t.kind === 'op' && t.text === '$') {
            this.pos++;
            return { k: 'field', index: this.parsePrimary(top) };
        }
        if (t.kind === 'op' && t.text === '(') {
            this.pos++;
            const group: AwkNode[] = [];
            this.skipSeparators();
            if (!this.at(')')) {
                group.push(this.parseExpr(false));
                while (this.eat(',')) {
                    this.skipSeparators();
                    group.push(this.parseExpr(false));
                }
            }
            this.expect(')');
            if (group.length === 1) return group[0];
            return { k: 'group', items: group };
        }
        if (t.kind === 'id') {
            this.pos++;
            return { k: 'var', name: t.text };
        }
        if (t.kind === 'op' && t.text === '|') {
            // `| "cmd"` in getline context: consume and treat as string
            this.pos++;
            return this.parsePrimary(top);
        }
        throw new AwkParseError(`unexpected token ${t.text}`);
    }
}

/* ---- interpreter ---- */

class AwkReturnSignal {
    constructor(public value: AwkVal) {}
}
class AwkExitSignal {
    constructor(public code: number) {}
}
class AwkNextSignal {}
class AwkBreakSignal {}
class AwkContinueSignal {}

interface AwkArray {
    [key: string]: AwkVal;
}

class AwkInterp {
    globals: Record<string, AwkVal> = Object.create(null);
    arrays: Record<string, AwkArray> = Object.create(null);
    functions: Record<string, AwkNode> = Object.create(null);
    fields: string[] = [];
    record = '';
    nf = 0;
    nr = 0;
    fnr = 0;
    filename = '';
    output = '';
    rstart = 0;
    rlength = -1;
    randSeed = 1;
    /** File redirection buffers for `print > file`. */
    redirections: Record<string, string> = Object.create(null);

    constructor(public ctx: CommandContext) {
        this.globals['FS'] = str(' ');
        this.globals['OFS'] = str(' ');
        this.globals['ORS'] = str('\n');
        this.globals['RS'] = str('\n');
        this.globals['NR'] = num(0);
        this.globals['NF'] = num(0);
        this.globals['FNR'] = num(0);
        this.globals['FILENAME'] = str('');
        this.globals['SUBSEP'] = str('\x1c');
        this.globals['CONVFMT'] = str('%.6g');
        this.globals['OFMT'] = str('%.6g');
        this.globals['RSTART'] = num(0);
        this.globals['RLENGTH'] = num(-1);
    }

    special(name: string): AwkVal | undefined {
        switch (name) {
            case 'NR':
                return num(this.nr);
            case 'NF':
                return num(this.nf);
            case 'FNR':
                return num(this.fnr);
            case 'RSTART':
                return num(this.rstart);
            case 'RLENGTH':
                return num(this.rlength);
            default:
                return undefined;
        }
    }

    setSpecial(name: string, value: AwkVal): boolean {
        switch (name) {
            case 'NF':
                this.setFieldCount(awkToNum(value));
                return true;
            case 'NR':
            case 'FNR':
            case 'RSTART':
            case 'RLENGTH':
                return true;
            default:
                return false;
        }
    }

    setFieldCount(count: number): void {
        const wanted = Math.max(0, Math.floor(count));
        while (this.fields.length > wanted) this.fields.pop();
        while (this.fields.length < wanted) this.fields.push('');
        this.record = this.joinFields();
        this.nf = this.fields.length;
    }

    joinFields(): string {
        return this.fields.join(awkToStr(this.globals['OFS'] ?? str(' '), '%.6g'));
    }

    splitRecord(text: string): void {
        this.fields = this.splitFields(text);
        this.nf = this.fields.length;
        this.record = text;
    }

    splitFields(text: string): string[] {
        const fs = awkToStr(this.globals['FS'] ?? str(' '), '%.6g');
        if (fs === ' ') {
            const trimmed = text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
            return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/);
        }
        if (fs.length === 1) {
            if (fs === '\t' || fs === '\n' || fs === '\\') return text.split(fs);
            return text.split(fs);
        }
        try {
            return text.split(new RegExp(posixReToJs(fs, true)));
        } catch {
            return text.split(fs);
        }
    }

    toStr(v: AwkVal): string {
        return awkToStr(v, awkToStr(this.globals['CONVFMT'] ?? str('%.6g'), '%.6g'));
    }

    getVar(name: string): AwkVal {
        const sp = this.special(name);
        if (sp !== undefined) return sp;
        const v = this.globals[name];
        return v === undefined ? uninit() : v;
    }

    setVar(name: string, value: AwkVal): void {
        if (this.setSpecial(name, value)) return;
        this.globals[name] = value;
    }

    getArray(name: string): AwkArray {
        let a = this.arrays[name];
        if (!a) {
            a = Object.create(null) as AwkArray;
            this.arrays[name] = a;
        }
        return a;
    }

    getField(index: AwkVal): AwkVal {
        const i = Math.trunc(awkToNum(index));
        if (i === 0) {
            const n = looksNumeric(this.record);
            return n === null ? str(this.record) : strnum(this.record, n);
        }
        if (i < 1 || i > this.fields.length) return uninit();
        const text = this.fields[i - 1];
        const n = looksNumeric(text);
        return n === null ? str(text) : strnum(text, n);
    }

    setField(index: AwkVal, value: AwkVal): void {
        const i = Math.trunc(awkToNum(index));
        const text = this.toStr(value);
        if (i === 0) {
            this.splitRecord(text);
            return;
        }
        if (i >= 1) {
            while (this.fields.length < i) this.fields.push('');
            this.fields[i - 1] = text;
            this.nf = this.fields.length;
            this.record = this.joinFields();
        }
    }

    lvalue(node: AwkNode): { get: () => AwkVal; set: (v: AwkVal) => void } {
        if (node.k === 'var') {
            const name = node.name as string;
            return {
                get: () => this.getVar(name),
                set: (v) => this.setVar(name, v),
            };
        }
        if (node.k === 'field') {
            const index = this.eval(node.index);
            return {
                get: () => this.getField(index),
                set: (v) => this.setField(index, v),
            };
        }
        if (node.k === 'index') {
            const base = node.arr as AwkNode;
            if (base.k !== 'var') throw new AwkParseError('not an lvalue');
            const name = base.name as string;
            const key = this.toStr(this.eval(node.index));
            const arr = this.getArray(name);
            return {
                get: () => arr[key] ?? uninit(),
                set: (v) => {
                    arr[key] = v;
                },
            };
        }
        throw new AwkParseError('not an lvalue');
    }

    eval(node: AwkNode): AwkVal {
        switch (node.k) {
            case 'lit':
                return node.value as AwkVal;
            case 'regex':
                return str((node.re as RegExp).source);
            case 'var':
                return this.getVar(node.name as string);
            case 'field':
                return this.getField(this.eval(node.index));
            case 'index': {
                const base = node.arr as AwkNode;
                if (base.k === 'var') {
                    const arr = this.getArray(base.name as string);
                    const key = this.toStr(this.eval(node.index));
                    return arr[key] ?? uninit();
                }
                return uninit();
            }
            case 'group': {
                const items = node.items as AwkNode[];
                return items.length > 0 ? this.eval(items[items.length - 1]) : uninit();
            }
            case 'concat':
                return str(this.toStr(this.eval(node.left)) + this.toStr(this.eval(node.right)));
            case 'unary': {
                const v = this.eval(node.operand);
                if (node.op === '!') return num(awkTruthy(v) ? 0 : 1);
                if (node.op === '-') return num(-awkToNum(v));
                return num(awkToNum(v));
            }
            case 'pre': {
                const lv = this.lvalue(node.operand);
                const before = awkToNum(lv.get());
                const after = node.op === '++' ? before + 1 : before - 1;
                lv.set(num(after));
                return num(after);
            }
            case 'post': {
                const lv = this.lvalue(node.operand);
                const before = awkToNum(lv.get());
                const after = node.op === '++' ? before + 1 : before - 1;
                lv.set(num(after));
                return num(before);
            }
            case 'bin':
                return this.evalBinary(node);
            case 'ternary':
                return awkTruthy(this.eval(node.cond)) ? this.eval(node.a) : this.eval(node.b);
            case 'assign': {
                const value = this.eval(node.value);
                const lv = this.lvalue(node.target);
                let result = value;
                if (node.op !== '=') {
                    const current = awkToNum(lv.get());
                    const other = awkToNum(value);
                    switch (node.op) {
                        case '+=':
                            result = num(current + other);
                            break;
                        case '-=':
                            result = num(current - other);
                            break;
                        case '*=':
                            result = num(current * other);
                            break;
                        case '/=':
                            result = num(other === 0 ? NaN : current / other);
                            break;
                        case '%=':
                            result = num(other === 0 ? NaN : current % other);
                            break;
                        case '^=':
                            result = num(Math.pow(current, other));
                            break;
                        default:
                            result = value;
                    }
                } else if (value.t === V_UNINIT) {
                    result = value;
                }
                lv.set(result);
                return result;
            }
            case 'call': {
                const callee = node.callee as AwkNode;
                if (callee.k === 'var') {
                    const name = callee.name as string;
                    const argNodes = node.args as AwkNode[];
                    const args = argNodes.map((a) => this.eval(a));
                    if (this.functions[name]) return this.callFunction(name, args);
                    return this.callBuiltin(name, args, argNodes);
                }
                throw new AwkParseError('unsupported call');
            }
            case 'in': {
                const target = node.right as AwkNode;
                if (target.k === 'var') {
                    const arr = this.getArray(target.name as string);
                    const key = this.toStr(this.eval(node.left));
                    return num(key in arr ? 1 : 0);
                }
                return num(0);
            }
            default:
                throw new AwkParseError(`cannot evaluate ${node.k}`);
        }
    }

    evalBinary(node: AwkNode): AwkVal {
        const op = node.op as string;
        if (op === '&&') {
            if (!awkTruthy(this.eval(node.left))) return num(0);
            return num(awkTruthy(this.eval(node.right)) ? 1 : 0);
        }
        if (op === '||') {
            if (awkTruthy(this.eval(node.left))) return num(1);
            return num(awkTruthy(this.eval(node.right)) ? 1 : 0);
        }
        const a = this.eval(node.left);
        const b = this.eval(node.right);
        switch (op) {
            case '+':
                return num(awkToNum(a) + awkToNum(b));
            case '-':
                return num(awkToNum(a) - awkToNum(b));
            case '*':
                return num(awkToNum(a) * awkToNum(b));
            case '/': {
                const d = awkToNum(b);
                return num(d === 0 ? NaN : awkToNum(a) / d);
            }
            case '%': {
                const d = awkToNum(b);
                return num(d === 0 ? NaN : awkToNum(a) % d);
            }
            case '^':
                return num(Math.pow(awkToNum(a), awkToNum(b)));
            case '==':
                return num(awkCompare(a, b) === 0 ? 1 : 0);
            case '!=':
                return num(awkCompare(a, b) !== 0 ? 1 : 0);
            case '<':
                return num(awkCompare(a, b) < 0 ? 1 : 0);
            case '<=':
                return num(awkCompare(a, b) <= 0 ? 1 : 0);
            case '>':
                return num(awkCompare(a, b) > 0 ? 1 : 0);
            case '>=':
                return num(awkCompare(a, b) >= 0 ? 1 : 0);
            case '~':
            case '!~': {
                const text = this.toStr(a);
                const re = this.toRegex(b);
                re.lastIndex = 0;
                const hit = re.test(text);
                return num((op === '~' ? hit : !hit) ? 1 : 0);
            }
            default:
                return num(0);
        }
    }

    toRegex(v: AwkVal): RegExp {
        const text = this.toStr(v);
        return new RegExp(posixReToJs(text, true));
    }

    /** Expand `&` and `\1`-style backreferences in a sub/gsub replacement. */
    expandSub(text: string, re: RegExp, replacement: string, global: boolean): { text: string; count: number } {
        let outText = '';
        let last = 0;
        let count = 0;
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            count++;
            let piece = '';
            for (let i = 0; i < replacement.length; i++) {
                if (replacement[i] === '\\' && i + 1 < replacement.length) {
                    const d = replacement[i + 1];
                    if (d === '&') {
                        piece += '&';
                        i++;
                        continue;
                    }
                    if (d === '\\') {
                        piece += '\\';
                        i++;
                        continue;
                    }
                    if (d >= '1' && d <= '9') {
                        piece += m[parseInt(d, 10)] ?? '';
                        i++;
                        continue;
                    }
                    piece += d;
                    i++;
                    continue;
                }
                if (replacement[i] === '&') {
                    piece += m[0];
                    continue;
                }
                piece += replacement[i];
            }
            outText += text.slice(last, m.index) + piece;
            last = m.index + m[0].length;
            if (!global) break;
            if (m[0].length === 0) re.lastIndex++;
            if (count > 100000) break;
        }
        if (count === 0) return { text, count: 0 };
        return { text: outText + text.slice(last), count };
    }

    callFunction(name: string, args: AwkVal[]): AwkVal {
        const fn = this.functions[name];
        const saved: Record<string, AwkVal> = Object.create(null);
        const params = fn.params as string[];
        for (let i = 0; i < params.length; i++) {
            saved[params[i]] = this.globals[params[i]];
            this.globals[params[i]] = args[i] ?? uninit();
        }
        try {
            this.execBlock(fn.body as AwkNode[]);
            return uninit();
        } catch (e) {
            if (e instanceof AwkReturnSignal) return e.value;
            throw e;
        } finally {
            for (let i = 0; i < params.length; i++) {
                if (saved[params[i]] === undefined) delete this.globals[params[i]];
                else this.globals[params[i]] = saved[params[i]];
            }
        }
    }

    callBuiltin(name: string, args: AwkVal[], argNodes: AwkNode[]): AwkVal {
        switch (name) {
            case 'length':
                if (args.length === 0) {
                    const record = this.record;
                    const n = looksNumeric(record);
                    return num(n === null ? [...record].length : [...record].length);
                }
                return num([...this.toStr(args[0])].length);
            case 'substr': {
                const text = this.toStr(args[0] ?? str(''));
                const chars = [...text];
                let start = Math.trunc(awkToNum(args[1] ?? num(1)));
                if (start < 1) start = 1;
                if (args.length >= 3) {
                    let count = Math.trunc(awkToNum(args[2]));
                    if (count < 0) count = 0;
                    return str(chars.slice(start - 1, start - 1 + count).join(''));
                }
                return str(chars.slice(start - 1).join(''));
            }
            case 'index': {
                const hay = this.toStr(args[0] ?? str(''));
                const needle = this.toStr(args[1] ?? str(''));
                return num(needle === '' ? 0 : hay.indexOf(needle) + 1);
            }
            case 'split': {
                const text = this.toStr(args[0] ?? str(''));
                const target = argNodes[1];
                let fs: string | null = null;
                if (args.length >= 3) fs = this.toStr(args[2]);
                let parts: string[];
                if (fs === null) {
                    parts = this.splitFields(text);
                } else if (fs.length === 1) {
                    parts = fs === ' ' ? this.splitFields(text) : text.split(fs);
                } else {
                    parts = text.split(new RegExp(posixReToJs(fs, true)));
                }
                if (target && target.k === 'var') {
                    const arr = Object.create(null) as AwkArray;
                    for (let i = 0; i < parts.length; i++) {
                        const n = looksNumeric(parts[i]);
                        arr[String(i + 1)] = n === null ? str(parts[i]) : strnum(parts[i], n);
                    }
                    this.arrays[target.name as string] = arr;
                }
                return num(parts.length);
            }
            case 'gsub':
            case 'sub': {
                const reText = this.toStr(args[0] ?? str(''));
                const replacement = this.toStr(args[1] ?? str(''));
                const target = argNodes[2] ?? { k: 'field', index: { k: 'lit', value: num(0) } };
                const lv = this.lvalue(target);
                const text = this.toStr(lv.get());
                const re = new RegExp(posixReToJs(reText, true), name === 'gsub' ? 'g' : '');
                const expanded = this.expandSub(text, re, replacement, name === 'gsub');
                lv.set(str(expanded.text));
                return num(expanded.count);
            }
            case 'match': {
                const text = this.toStr(args[0] ?? str(''));
                const re = new RegExp(posixReToJs(this.toStr(args[1] ?? str('')), true));
                const m = re.exec(text);
                if (!m) {
                    this.rstart = 0;
                    this.rlength = -1;
                    return num(0);
                }
                this.rstart = m.index + 1;
                this.rlength = m[0].length;
                return num(m.index + 1);
            }
            case 'sprintf': {
                const fmt = this.toStr(args[0] ?? str(''));
                return str(sprintfFormat(fmt, args.slice(1)));
            }
            case 'tolower':
                return str(this.toStr(args[0] ?? str('')).toLowerCase());
            case 'toupper':
                return str(this.toStr(args[0] ?? str('')).toUpperCase());
            case 'sin':
                return num(Math.sin(awkToNum(args[0] ?? num(0))));
            case 'cos':
                return num(Math.cos(awkToNum(args[0] ?? num(0))));
            case 'atan2':
                return num(Math.atan2(awkToNum(args[0] ?? num(0)), awkToNum(args[1] ?? num(0))));
            case 'exp':
                return num(Math.exp(awkToNum(args[0] ?? num(0))));
            case 'log':
                return num(Math.log(awkToNum(args[0] ?? num(0))));
            case 'sqrt':
                return num(Math.sqrt(awkToNum(args[0] ?? num(0))));
            case 'int':
                return num(Math.trunc(awkToNum(args[0] ?? num(0))));
            case 'rand': {
                this.randSeed = (this.randSeed * 1103515245 + 12345) % 2147483648;
                return num(this.randSeed / 2147483648);
            }
            case 'srand': {
                const seed = args.length > 0 ? Math.trunc(awkToNum(args[0])) : Math.floor(Math.random() * 2147483648);
                this.randSeed = ((seed % 2147483648) + 2147483648) % 2147483648;
                return num(0);
            }
            default:
                throw new AwkParseError(`unknown function ${name}`);
        }
    }

    execBlock(stmts: AwkNode[]): void {
        for (const s of stmts) this.exec(s);
    }

    exec(node: AwkNode): void {
        switch (node.k) {
            case 'block':
                this.execBlock(node.body as AwkNode[]);
                return;
            case 'expr':
                this.eval(node.expr);
                return;
            case 'if':
                if (awkTruthy(this.eval(node.cond))) this.exec(node.then);
                else if (node.other) this.exec(node.other);
                return;
            case 'while':
                while (awkTruthy(this.eval(node.cond))) {
                    try {
                        this.exec(node.body);
                    } catch (e) {
                        if (e instanceof AwkBreakSignal) break;
                        if (e instanceof AwkContinueSignal) continue;
                        throw e;
                    }
                }
                return;
            case 'do':
                for (;;) {
                    try {
                        this.exec(node.body);
                    } catch (e) {
                        if (e instanceof AwkBreakSignal) break;
                        if (!(e instanceof AwkContinueSignal)) throw e;
                    }
                    if (!awkTruthy(this.eval(node.cond))) break;
                }
                return;
            case 'for': {
                if (node.init) this.exec(node.init);
                for (;;) {
                    if (node.cond && !awkTruthy(this.eval(node.cond))) break;
                    try {
                        this.exec(node.body);
                    } catch (e) {
                        if (e instanceof AwkBreakSignal) break;
                        if (!(e instanceof AwkContinueSignal)) throw e;
                    }
                    if (node.incr) this.exec(node.incr);
                }
                return;
            }
            case 'forin': {
                const target = node.arr as AwkNode;
                if (target.k !== 'var') throw new AwkParseError('for-in over non-array');
                const arr = this.getArray(target.name as string);
                for (const key of Object.keys(arr)) {
                    this.setVar(node.name as string, looksNumeric(key) === null ? str(key) : strnum(key, looksNumeric(key) as number));
                    try {
                        this.exec(node.body);
                    } catch (e) {
                        if (e instanceof AwkBreakSignal) break;
                        if (!(e instanceof AwkContinueSignal)) throw e;
                    }
                }
                return;
            }
            case 'print': {
                const args = node.args as AwkNode[];
                const ofs = this.toStr(this.globals['OFS'] ?? str(' '));
                const ors = this.toStr(this.globals['ORS'] ?? str('\n'));
                let text =
                    args.length === 0
                        ? this.record
                        : args.map((a) => this.printValue(this.eval(a))).join(ofs);
                text += ors;
                this.write(text, node);
                return;
            }
            case 'printf': {
                const args = node.args as AwkNode[];
                if (args.length === 0) return;
                const fmt = this.toStr(this.eval(args[0]));
                const rest = args.slice(1).map((a) => this.eval(a));
                this.write(sprintfFormat(fmt, rest), node);
                return;
            }
            case 'next':
                throw new AwkNextSignal();
            case 'exit': {
                const value = node.value ? this.eval(node.value) : null;
                throw new AwkExitSignal(value ? Math.trunc(awkToNum(value)) : 0);
            }
            case 'return':
                throw new AwkReturnSignal(node.value ? this.eval(node.value) : uninit());
            case 'break':
                throw new AwkBreakSignal();
            case 'continue':
                throw new AwkContinueSignal();
            case 'delete': {
                const target = node.target as AwkNode;
                if (target.k === 'index') {
                    const base = target.arr as AwkNode;
                    if (base.k === 'var') {
                        const arr = this.getArray(base.name as string);
                        delete arr[this.toStr(this.eval(target.index))];
                    }
                }
                return;
            }
            default:
                throw new AwkParseError(`cannot execute ${node.k}`);
        }
    }

    printValue(v: AwkVal): string {
        if (v.t === V_NUM) return numToString(v.n, this.toStr(this.globals['OFMT'] ?? str('%.6g')));
        return this.toStr(v);
    }

    write(text: string, node: AwkNode): void {
        const redirect = node.redirect as AwkNode | null;
        if (redirect) {
            const name = this.toStr(this.eval(redirect));
            this.redirections[name] = (this.redirections[name] ?? '') + text;
            return;
        }
        this.output += text;
    }
}

function sprintfFormat(fmt: string, args: AwkVal[]): string {
    let outText = '';
    let index = 0;
    let argIndex = 0;
    while (index < fmt.length) {
        const c = fmt[index];
        if (c !== '%') {
            outText += c;
            index++;
            continue;
        }
        index++;
        if (fmt[index] === '%') {
            outText += '%';
            index++;
            continue;
        }
        let flags = '';
        while (index < fmt.length && '+- 0#'.indexOf(fmt[index]) >= 0) {
            flags += fmt[index];
            index++;
        }
        let width = '';
        while (index < fmt.length && /\d/.test(fmt[index])) {
            width += fmt[index];
            index++;
        }
        let precision = '';
        if (fmt[index] === '.') {
            precision += '.';
            index++;
            while (index < fmt.length && /\d/.test(fmt[index])) {
                precision += fmt[index];
                index++;
            }
        }
        let conv = fmt[index] ?? '';
        index++;
        if (conv === '*') {
            width = String(Math.trunc(awkToNum(args[argIndex++] ?? num(0))));
            conv = fmt[index] ?? '';
            index++;
        }
        if (conv === 'c') {
            const v = args[argIndex++] ?? uninit();
            if (v.t === V_NUM) outText += String.fromCharCode(v.n);
            else outText += (v.s || '')[0] ?? '';
            continue;
        }
        const value = args[argIndex++] ?? uninit();
        outText += formatOne(flags, width, precision, conv, value);
    }
    return outText;
}

function formatOne(flags: string, width: string, precision: string, conv: string, value: AwkVal): string {
    const w = width === '' ? 0 : parseInt(width, 10);
    const p = precision === '' || precision === '.' ? null : parseInt(precision.slice(1), 10);
    let body: string;
    switch (conv) {
        case 'd':
        case 'i': {
            const n = Math.trunc(awkToNum(value));
            body = Math.abs(n).toString();
            if (n < 0) body = '-' + body;
            else if (flags.indexOf('+') >= 0) body = '+' + body;
            else if (flags.indexOf(' ') >= 0) body = ' ' + body;
            break;
        }
        case 'o':
        case 'x':
        case 'X': {
            const n = Math.trunc(awkToNum(value));
            const base = conv === 'o' ? 8 : 16;
            body = (n < 0 ? n >>> 0 : n).toString(base);
            if (conv === 'X') body = body.toUpperCase();
            break;
        }
        case 'e':
        case 'E':
        case 'f':
        case 'F':
        case 'g':
        case 'G': {
            const n = awkToNum(value);
            if (conv === 'e' || conv === 'E') {
                body = p === null ? n.toExponential(6) : n.toExponential(p);
                if (conv === 'E') body = body.toUpperCase();
            } else if (conv === 'f' || conv === 'F') {
                body = p === null ? n.toFixed(6) : n.toFixed(p);
            } else {
                body = p === null ? String(n) : n.toPrecision(Math.max(1, p));
                if (p !== null) {
                    const exp = /e([+-])(\d+)$/.exec(body);
                    if (exp) {
                        body = body.replace(/e([+-])(\d+)$/, (m, sign, digits) => 'e' + sign + digits.padStart(2, '0'));
                    }
                }
                if (conv === 'G') body = body.toUpperCase();
            }
            if (!Number.isFinite(n)) body = Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';
            if (n >= 0 && flags.indexOf('+') >= 0) body = '+' + body;
            else if (n >= 0 && flags.indexOf(' ') >= 0) body = ' ' + body;
            break;
        }
        case 's': {
            body = awkToStr(value, '%.6g');
            if (p !== null) body = body.slice(0, p);
            break;
        }
        default:
            body = '';
    }
    const numeric = 'diouxXeEfFgG'.indexOf(conv) >= 0;
    if (w > body.length) {
        const pad = ' '.repeat(w - body.length);
        if (flags.indexOf('-') >= 0) body = body + pad;
        else if (flags.indexOf('0') >= 0 && numeric) {
            const sign = /^[+-]/.test(body) ? body[0] : '';
            body = sign + '0'.repeat(w - body.length) + body.slice(sign.length);
        } else body = pad + body;
    }
    return body;
}

function awkSplitRecords(text: string, rs: string): string[] {
    if (rs === '') {
        const trimmed = text.replace(/^\n+/, '').replace(/\n+$/, '');
        if (trimmed === '') return [];
        return trimmed.split(/\n{2,}/).map((r) => r.replace(/\n+$/, ''));
    }
    if (text === '') return [];
    let parts: string[];
    if (rs.length === 1) {
        parts = text.split(rs);
    } else {
        try {
            parts = text.split(new RegExp(posixReToJs(rs, true)));
        } catch {
            parts = text.split(rs);
        }
    }
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
}

const cmdAwk: ShellCommand = (ctx: CommandContext): CommandResult => {
    const args = ctx.args;
    let program = '';
    const assignments: string[] = [];
    const files: string[] = [];
    let fsValue: string | null = null;
    let sawProgram = false;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg.length > 1 && arg[0] === '-') {
            if (arg[1] === 'F') {
                fsValue = arg.length > 2 ? arg.slice(2) : args[++i] ?? '';
                continue;
            }
            if (arg[1] === 'v') {
                const value = arg.length > 2 ? arg.slice(2) : args[++i] ?? '';
                assignments.push(value);
                continue;
            }
            if (arg[1] === 'f') {
                const value = arg.length > 2 ? arg.slice(2) : args[++i] ?? '';
                const text = ctx.fs.readFile(atPath(ctx, value));
                if (text === undefined) return err(`awk: can't open file ${value}\n`, 2);
                program += (program === '' ? '' : '\n') + text;
                sawProgram = true;
                continue;
            }
            if (arg === '-') {
                files.push('-');
                continue;
            }
            return err(`awk: illegal option -- ${arg[1]}\n`, 2);
        }
        if (arg === '-') {
            files.push('-');
            continue;
        }
        if (!sawProgram) {
            program = arg;
            sawProgram = true;
            continue;
        }
        break;
    }
    for (; i < args.length; i++) {
        const arg = args[i];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && files.length === 0) {
            assignments.push(arg);
            continue;
        }
        files.push(arg);
    }

    if (program === '') {
        if (files.length === 0) {
            return err(AWK_USAGE, 1);
        }
        program = files[0];
        files.shift();
    }

    let items: AwkNode[];
    try {
        items = new AwkParser(awkTokenize(program)).parseProgram();
    } catch (e) {
        return err(`awk: syntax error: ${(e as Error).message}\n`, 2);
    }

    const interp = new AwkInterp(ctx);
    if (fsValue !== null) interp.globals['FS'] = str(fsValue);

    for (const item of items) if (item.k === 'func') interp.functions[item.name as string] = item;

    const applyAssignment = (text: string): void => {
        const at = text.indexOf('=');
        const name = text.slice(0, at);
        const raw = text.slice(at + 1);
        const n = looksNumeric(raw);
        interp.setVar(name, n === null ? str(raw) : strnum(raw, n));
    };
    for (const assignment of assignments) applyAssignment(assignment);

    const runRules = (which: 'BEGIN' | 'END'): void => {
        const list = items.filter((it) => it.k === 'rule' && it.begin === which);
        for (const rule of list) {
            try {
                interp.execBlock(rule.body as AwkNode[]);
            } catch (e) {
                if (e instanceof AwkExitSignal) {
                    throw e;
                }
                throw e;
            }
        }
    };

    const sources: NamedText[] = [];
    if (files.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
    } else {
        for (const file of files) {
            if (file === '-') {
                sources.push({ name: '-', text: ctx.input ?? '' });
                continue;
            }
            const info = readOne(ctx, file);
            if (info.text === undefined) {
                return err(`awk: can't open file ${file}\n`, 2);
            }
            sources.push({ name: file, text: info.text });
        }
    }

    const rangeActive: boolean[] = [];
    let rangeId = 0;
    for (const item of items) {
        if (item.k === 'rule' && item.end) (item as any).__rangeId = rangeId++;
    }

    let exitCode = 0;
    let exited = false;

    /** A rule pattern holds when it is a regex matching the record, or a true expression. */
    const patternMatches = (node: AwkNode | null): boolean => {
        if (node === null) return true;
        if (node.k === 'regex') {
            (node.re as RegExp).lastIndex = 0;
            return (node.re as RegExp).test(interp.record);
        }
        return awkTruthy(interp.eval(node));
    };
    const runMain = (): void => {
        for (const item of items) {
            if (item.k !== 'rule' || item.begin !== null) continue;
            const rule = item;
            let active: boolean;
            if (rule.end) {
                const id = (rule as any).__rangeId as number;
                if (rangeActive[id]) {
                    active = true;
                    if (patternMatches(rule.end)) rangeActive[id] = false;
                } else if (patternMatches(rule.pattern)) {
                    active = true;
                    if (!patternMatches(rule.end)) rangeActive[id] = true;
                } else {
                    active = false;
                }
            } else {
                active = patternMatches(rule.pattern);
            }
            if (!active) continue;
            if (rule.body === null) {
                interp.output += interp.record + awkToStr(interp.globals['ORS'] ?? str('\n'), '%.6g');
            } else {
                interp.execBlock(rule.body as AwkNode[]);
            }
        }
    };

    try {
        for (const rule of items.filter((it) => it.k === 'rule' && it.begin === 'BEGIN')) {
            interp.execBlock(rule.body as AwkNode[]);
        }
        const rs = awkToStr(interp.globals['RS'] ?? str('\n'), '%.6g');
        for (const source of sources) {
            interp.filename = source.name;
            interp.globals['FILENAME'] = str(source.name);
            interp.fnr = 0;
            const records = awkSplitRecords(source.text, rs);
            for (const record of records) {
                interp.nr++;
                interp.fnr++;
                interp.splitRecord(record);
                try {
                    runMain();
                } catch (e) {
                    if (e instanceof AwkNextSignal) continue;
                    throw e;
                }
            }
        }
        runRules('END');
    } catch (e) {
        if (e instanceof AwkExitSignal) {
            exitCode = e.code;
            exited = true;
            if (!exited) return out('');
            try {
                runRules('END');
            } catch {
                /* END itself exited: keep the last code */
            }
        } else {
            return err(`awk: ${(e as Error).message}\n`, 2, interp.output);
        }
    }

    for (const name of Object.keys(interp.redirections)) {
        ctx.fs.writeFile(atPath(ctx, name), interp.redirections[name]);
    }

    return { stdout: interp.output, stderr: '', exitCode };
};

/* ================================================================== *
 * cut
 * ================================================================== */

function decodeUtf8(bytes: number[]): string {
    let outText = '';
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        if (b < 0x80) {
            outText += String.fromCharCode(b);
            i++;
            continue;
        }
        let need = 0;
        let cp = 0;
        if (b >= 0xc2 && b <= 0xdf) {
            need = 1;
            cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
            need = 2;
            cp = b & 0x0f;
        } else if (b >= 0xf0 && b <= 0xf4) {
            need = 3;
            cp = b & 0x07;
        } else {
            outText += '�';
            i++;
            continue;
        }
        if (i + need >= bytes.length) {
            outText += '�';
            i++;
            continue;
        }
        let okRun = true;
        for (let k = 1; k <= need; k++) {
            if ((bytes[i + k] & 0xc0) !== 0x80) {
                okRun = false;
                break;
            }
            cp = (cp << 6) | (bytes[i + k] & 0x3f);
        }
        if (!okRun) {
            outText += '�';
            i++;
            continue;
        }
        if (cp > 0x10ffff) {
            outText += '�';
            i += need + 1;
            continue;
        }
        outText += String.fromCodePoint(cp);
        i += need + 1;
    }
    return outText;
}

interface RangeItem {
    low: number;
    high: number | null;
}

function parseRangeList(text: string, max: number): RangeItem[] {
    const items: RangeItem[] = [];
    for (const part of text.split(',')) {
        if (part === '') throw new Error('empty list element');
        const m = /^(\d*)(?:-(\d*))?$/.exec(part);
        if (!m) throw new Error('invalid byte or field list');
        const lowText = m[1];
        const highText = m[2];
        if (lowText === '' && highText === undefined) throw new Error('invalid byte or field list');
        let low: number;
        let high: number | null;
        if (highText === undefined) {
            low = parseInt(lowText, 10);
            high = low;
        } else {
            low = lowText === '' ? 1 : parseInt(lowText, 10);
            high = highText === '' ? max : parseInt(highText, 10);
        }
        if (low < 1 || (high !== null && high < low)) throw new Error('invalid byte or field list');
        items.push({ low, high });
    }
    return items.sort((a, b) => a.low - b.low);
}

function selectByRange(count: number, items: RangeItem[]): number[] {
    const chosen: number[] = [];
    for (const item of items) {
        const high = item.high === null ? count : Math.min(item.high, count);
        for (let p = item.low; p <= high; p++) if (p >= 1) chosen.push(p - 1);
    }
    return chosen;
}

const cmdCut: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['s', 'n']), valued: new Set(['b', 'c', 'f', 'd']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    const listText =
        lastValue(scanned.values, 'b') ?? lastValue(scanned.values, 'c') ?? lastValue(scanned.values, 'f');
    const mode =
        lastValue(scanned.values, 'b') !== undefined
            ? 'b'
            : lastValue(scanned.values, 'c') !== undefined
              ? 'c'
              : lastValue(scanned.values, 'f') !== undefined
                ? 'f'
                : null;
    if (mode === null || listText === undefined) {
        return err(CUT_USAGE, 1);
    }
    let delim = '\t';
    const delimArg = lastValue(scanned.values, 'd');
    if (delimArg !== undefined) delim = delimArg;
    const onlyDelimited = hasFlag(scanned.flags, 's');

    let items: RangeItem[];
    try {
        items = parseRangeList(listText, Number.MAX_SAFE_INTEGER);
    } catch (e) {
        return err(`cut: ${(e as Error).message}\n`, 2);
    }

    const files = scanned.operands;
    const sources: NamedText[] = [];
    if (files.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
    } else {
        for (const file of files) {
            if (file === '-') {
                sources.push({ name: '-', text: ctx.input ?? '' });
                continue;
            }
            const info = readOne(ctx, file);
            if (info.text === undefined) return err(`cut: ${file}: No such file or directory\n`, 1);
            sources.push({ name: file, text: info.text });
        }
    }

    let stdoutText = '';
    for (const source of sources) {
        for (const line of splitLines(source.text)) {
            if (mode === 'f') {
                if (delim.length !== 1) return err('cut: the delimiter must be a single character\n', 2);
                if (line.indexOf(delim) < 0) {
                    if (onlyDelimited) continue;
                    stdoutText += line + '\n';
                    continue;
                }
                const parts = line.split(delim);
                const chosen = selectByRange(parts.length, items);
                stdoutText += chosen.map((i) => parts[i]).join(delim) + '\n';
                continue;
            }
            if (mode === 'c') {
                const chars = Array.from(line);
                const chosen = selectByRange(chars.length, items);
                stdoutText += chosen.map((i) => chars[i]).join('') + '\n';
                continue;
            }
            const bytes = utf8Bytes(line);
            const chosen = selectByRange(bytes.length, items);
            stdoutText += decodeUtf8(chosen.map((i) => bytes[i])) + '\n';
        }
    }
    return out(stdoutText);
};

/* ================================================================== *
 * sort
 * ================================================================== */

interface SortKeySpec {
    startField: number;
    startChar: number;
    endField: number | null;
    endChar: number | null;
    numeric: boolean;
    reverse: boolean;
    fold: boolean;
    ignoreBlanks: boolean;
}

function parseSortKey(text: string): SortKeySpec {
    const spec: SortKeySpec = {
        startField: 1,
        startChar: 0,
        endField: null,
        endChar: null,
        numeric: false,
        reverse: false,
        fold: false,
        ignoreBlanks: false,
    };
    const parts = text.split(',');
    const parsePos = (pos: string, isEnd: boolean): void => {
        const m = /^(\d+)(?:\.(\d+))?([A-Za-z]*)$/.exec(pos);
        if (!m) throw new Error('invalid key specification');
        const field = parseInt(m[1], 10);
        const charAt = m[2] === undefined ? 0 : parseInt(m[2], 10);
        if (isEnd) {
            spec.endField = field;
            spec.endChar = m[2] === undefined ? null : charAt;
        } else {
            spec.startField = field;
            spec.startChar = charAt;
            for (const ch of m[3] ?? '') {
                if (ch === 'n') spec.numeric = true;
                else if (ch === 'r') spec.reverse = true;
                else if (ch === 'f') spec.fold = true;
                else if (ch === 'b') spec.ignoreBlanks = true;
            }
        }
    };
    parsePos(parts[0], false);
    if (parts.length > 1) parsePos(parts[1], true);
    return spec;
}

function sortFieldText(line: string, sep: string | null, field: number): { start: number; end: number } {
    if (sep === null) {
        let index = 0;
        let current = 1;
        for (;;) {
            while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index++;
            if (current === field) break;
            while (index < line.length && line[index] !== ' ' && line[index] !== '\t') index++;
            while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index++;
            current++;
            if (index >= line.length) break;
        }
        if (index >= line.length && current !== field) return { start: line.length, end: line.length };
        let end = index;
        while (end < line.length && line[end] !== ' ' && line[end] !== '\t') end++;
        return { start: index, end };
    }
    const parts = line.split(sep);
    const index = field - 1;
    if (index < 0 || index >= parts.length) return { start: line.length, end: line.length };
    let start = 0;
    for (let i = 0; i < index; i++) start += parts[i].length + sep.length;
    return { start, end: start + parts[index].length };
}

function sortExtractKey(line: string, sep: string | null, spec: SortKeySpec, globalOpts: string[]): string {
    const start = sortFieldText(line, sep, spec.startField);
    let begin = start.start;
    if (spec.startChar > 0) begin = start.start + spec.startChar - 1;
    let end: number;
    if (spec.endField === null) {
        end = line.length;
    } else {
        const stop = sortFieldText(line, sep, spec.endField);
        if (spec.endChar === null || spec.endChar === 0) end = stop.end;
        else end = stop.start + spec.endChar;
    }
    let text = line.slice(begin, Math.max(begin, end));
    const blanks = spec.ignoreBlanks || globalOpts.indexOf('b') >= 0;
    if (blanks) text = text.replace(/^[ \t]+/, '');
    if (spec.endField !== null) text = text.replace(/[ \t]+$/, '');
    return text;
}

function numericPrefixCompare(a: string, b: string): number {
    const re = /^[ \t]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
    const ma = re.exec(a);
    const mb = re.exec(b);
    const bothNumeric = ma !== null && mb !== null;
    if (bothNumeric) {
        const na = parseFloat(ma[1]);
        const nb = parseFloat(mb[1]);
        if (na === nb) return 0;
        if (na < nb) return -1;
        return 1;
    }
    if (ma !== null) return -1;
    if (mb !== null) return 1;
    return byteCompare(a, b);
}

const cmdSort: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = {
        plain: new Set(['r', 'n', 'u', 'f', 'b', 's', 'M', 'h', 'z', 'c', 'm']),
        valued: new Set(['k', 't', 'o', 'S', 'T']),
    };
    const scanned = scanFlags(ctx.args, 0, spec);
    const reverse = hasFlag(scanned.flags, 'r');
    const numeric = hasFlag(scanned.flags, 'n');
    const unique = hasFlag(scanned.flags, 'u');
    const fold = hasFlag(scanned.flags, 'f');
    const ignoreBlanks = hasFlag(scanned.flags, 'b');
    const sepArg = lastValue(scanned.values, 't');
    const sep = sepArg === undefined ? null : sepArg === '\\t' ? '\t' : sepArg.slice(0, 1);
    const keys = (scanned.values['k'] ?? []).map(parseSortKey);
    const globalOpts: string[] = [];
    if (fold) globalOpts.push('f');
    if (ignoreBlanks) globalOpts.push('b');
    if (numeric) globalOpts.push('n');

    const files = scanned.operands;
    let text = '';
    if (files.length === 0) {
        text = ctx.input ?? '';
    } else {
        for (const file of files) {
            if (file === '-') {
                text += ctx.input ?? '';
                continue;
            }
            const info = readOne(ctx, file);
            if (info.text === undefined) return err(`sort: No such file or directory\n`, 2);
            text += info.text;
        }
    }

    let lines = splitLines(text);
    const comparePair = (a: string, b: string): number => {
        const specs = keys.length > 0 ? keys : [{ ...parseSortKey('1'), numeric, reverse, fold, ignoreBlanks }];
        for (const keySpec of specs) {
            const doNumeric = keys.length > 0 ? keySpec.numeric : numeric;
            const doFold = keys.length > 0 ? keySpec.fold : fold;
            const doReverse = keys.length > 0 ? reverse !== keySpec.reverse : reverse;
            let ka = sortExtractKey(a, sep, keySpec, globalOpts);
            let kb = sortExtractKey(b, sep, keySpec, globalOpts);
            if (doFold) {
                ka = ka.toLowerCase();
                kb = kb.toLowerCase();
            }
            let result = doNumeric ? numericPrefixCompare(ka, kb) : byteCompare(ka, kb);
            if (doReverse) result = -result;
            if (result !== 0) return result;
        }
        return 0;
    };
    lines = lines.slice().sort((a, b) => {
        const primary = comparePair(a, b);
        if (primary !== 0) return primary;
        return 0;
    });
    if (unique) {
        const kept: string[] = [];
        for (const line of lines) {
            const previous = kept[kept.length - 1];
            if (previous !== undefined && comparePair(previous, line) === 0) continue;
            kept.push(line);
        }
        lines = kept;
    }

    const outputText = joinLines(lines);
    const outFile = lastValue(scanned.values, 'o');
    if (outFile !== undefined) {
        ctx.fs.writeFile(atPath(ctx, outFile), outputText);
        return out('');
    }
    return out(outputText);
};

/* ================================================================== *
 * tr
 * ================================================================== */

function trParseSet(text: string): number[] {
    // BSD tr maps bytes, so the set is parsed over the UTF-8 encoding of the argument.
    const rawBytes = utf8Bytes(text);
    let byteText = '';
    for (const byte of rawBytes) byteText += String.fromCharCode(byte);
    text = byteText;
    const bytes: number[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            const d = text[i + 1];
            if (d === undefined) {
                bytes.push(92);
                i++;
                continue;
            }
            const escapes: Record<string, number> = {
                a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92,
            };
            if (escapes[d] !== undefined) {
                bytes.push(escapes[d]);
                i += 2;
                continue;
            }
            if (/^[0-7]{1,3}$/.test(text.slice(i + 1, i + 4))) {
                let digits = '';
                let k = i + 1;
                while (k < text.length && digits.length < 3 && text[k] >= '0' && text[k] <= '7') {
                    digits += text[k];
                    k++;
                }
                bytes.push(parseInt(digits, 8) & 0xff);
                i = k;
                continue;
            }
            bytes.push(d.charCodeAt(0) & 0xff);
            i += 2;
            continue;
        }
        if (c === '[' && text.startsWith('[:', i)) {
            const end = text.indexOf(':]', i);
            if (end !== -1) {
                const name = text.slice(i + 2, end);
                const expansion: Record<string, number[]> = {
                    alpha: trRange(0x41, 0x5a).concat(trRange(0x61, 0x7a)),
                    digit: trRange(0x30, 0x39),
                    alnum: trRange(0x41, 0x5a).concat(trRange(0x61, 0x7a), trRange(0x30, 0x39)),
                    upper: trRange(0x41, 0x5a),
                    lower: trRange(0x61, 0x7a),
                    space: [32, 9, 10, 11, 12, 13],
                    blank: [32, 9],
                    punct: trRange(0x21, 0x2f).concat(trRange(0x3a, 0x40), trRange(0x5b, 0x60), trRange(0x7b, 0x7e)),
                    print: trRange(0x20, 0x7e),
                    graph: trRange(0x21, 0x7e),
                    cntrl: trRange(0, 0x1f).concat([0x7f]),
                    xdigit: trRange(0x30, 0x39).concat(trRange(0x41, 0x46), trRange(0x61, 0x66)),
                };
                const values = expansion[name];
                if (values) {
                    for (const v of values) bytes.push(v);
                    i = end + 2;
                    continue;
                }
            }
        }
        if (c === '[' && /^\*(\d+)?\]$/.test(text.slice(i + 1))) {
            const repeatMatch = /^\*(\d+)?\]$/.exec(text.slice(i + 1));
            const repeat = repeatMatch && repeatMatch[1] !== undefined ? parseInt(repeatMatch[1], 10) : 0;
            const last = bytes[bytes.length - 1] ?? 0;
            for (let k = 0; k < repeat; k++) bytes.push(last);
            i = text.indexOf(']', i) + 1;
            continue;
        }
        if (text[i + 1] === '-' && text[i + 2] !== undefined && text[i + 2] !== ']') {
            const endChar = text[i + 2];
            const low = c.charCodeAt(0) & 0xff;
            const high = endChar.charCodeAt(0) & 0xff;
            if (low <= high) for (let v = low; v <= high; v++) bytes.push(v);
            else for (let v = low; v >= high; v--) bytes.push(v);
            i += 3;
            continue;
        }
        bytes.push(c.charCodeAt(0) & 0xff);
        i++;
    }
    return bytes;
}

function trRange(low: number, high: number): number[] {
    const values: number[] = [];
    for (let v = low; v <= high; v++) values.push(v);
    return values;
}

const cmdTr: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['c', 'C', 'd', 's', 'u']), valued: new Set() };
    const scanned = scanFlags(ctx.args, 0, spec);
    const complement = hasFlag(scanned.flags, 'c') || hasFlag(scanned.flags, 'C');
    const operands = scanned.operands;
    const usageText = TR_USAGE;
    const squeeze = hasFlag(scanned.flags, 's');
    const del = hasFlag(scanned.flags, 'd');
    const needed = del && !squeeze ? 1 : squeeze && !del ? 1 : 2;
    const allowed = del && !squeeze ? [1] : [1, 2];
    if (allowed.indexOf(operands.length) < 0) {
        return err(usageText, 1);
    }
    const set1 = trParseSet(operands[0]);
    const set2 = operands.length > 1 ? trParseSet(operands[1]) : [];
    const text: string = ctx.input ?? '';

    const inSet1 = new Uint8Array(256);
    const base = complement ? Array.from({ length: 256 }, (_, v) => v).filter((v) => set1.indexOf(v) < 0) : set1;
    for (const v of base) inSet1[v] = 1;

    const map = new Uint8Array(256);
    for (let v = 0; v < 256; v++) map[v] = v;
    const translate = operands.length >= 2 && !del;
    if (translate) {
        for (let i = 0; i < base.length; i++) {
            const target = set2.length === 0 ? 0 : set2[Math.min(i, set2.length - 1)];
            map[base[i]] = target;
        }
    }

    const inputBytes = utf8Bytes(text);
    const outputBytes: number[] = [];
    let last = -1;
    for (const byte of inputBytes) {
        if (del) {
            if (inSet1[byte]) continue;
            if (squeeze) {
                const squeezeSet = set2.length > 0 ? set2 : base;
                if (squeezeSet.indexOf(byte) >= 0 && byte === last) continue;
                last = byte;
            }
            outputBytes.push(byte);
            continue;
        }
        const mapped = map[byte];
        if (squeeze) {
            const squeezeSet = base;
            if (squeezeSet.indexOf(mapped) >= 0 && mapped === last) continue;
            last = mapped;
        }
        outputBytes.push(mapped);
    }
    return out(decodeUtf8(outputBytes));
};

/* ================================================================== *
 * paste
 * ================================================================== */

function unescapeDelims(text: string): string {
    let outText = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && i + 1 < text.length) {
            const d = text[i + 1];
            outText += d === 't' ? '\t' : d === 'n' ? '\n' : d === '0' ? '' : d;
            i++;
            continue;
        }
        outText += text[i];
    }
    return outText;
}

const cmdPaste: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['s']), valued: new Set(['d']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    const serial = hasFlag(scanned.flags, 's');
    const delims = unescapeDelims(lastValue(scanned.values, 'd') ?? '\t').split('');
    const files = scanned.operands;
    if (files.length === 0) {
        return err(PASTE_USAGE, 1);
    }
    const columns: string[][] = [];
    if (files.length === 0) {
        columns.push(splitLines(ctx.input ?? ''));
    } else {
        for (const file of files) {
            if (file === '-') {
                columns.push(splitLines(ctx.input ?? ''));
                continue;
            }
            const info = readOne(ctx, file);
            if (info.text === undefined) return err(`paste: ${file}: No such file or directory\n`, 1);
            columns.push(splitLines(info.text));
        }
    }
    let stdoutText = '';
    const delimAt = (index: number): string => delims[index % delims.length];
    if (serial) {
        for (const column of columns) {
            stdoutText += joinOne(column.length === 0 ? [''] : column, delimAt) + '\n';
        }
        return out(stdoutText);
    }
    let height = 0;
    for (const column of columns) height = Math.max(height, column.length);
    for (let row = 0; row < height; row++) {
        const pieces: string[] = [];
        for (let c = 0; c < columns.length; c++) pieces.push(columns[c][row] ?? '');
        stdoutText += joinOne(pieces, delimAt) + '\n';
    }
    return out(stdoutText);
};

function joinOne(pieces: string[], delimAt: (index: number) => string): string {
    let text = '';
    for (let i = 0; i < pieces.length; i++) {
        if (i > 0) text += delimAt(i - 1);
        text += pieces[i];
    }
    return text;
}

/* ================================================================== *
 * uniq
 * ================================================================== */

const cmdUniq: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['c', 'd', 'u', 'i']), valued: new Set(['f', 's', 'w', 'g', 'D']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    const count = hasFlag(scanned.flags, 'c');
    const repeated = hasFlag(scanned.flags, 'd');
    const unrepeated = hasFlag(scanned.flags, 'u');
    const ignoreCase = hasFlag(scanned.flags, 'i');
    const skipFields = parseCount(lastValue(scanned.values, 'f'), 0);
    const skipChars = parseCount(lastValue(scanned.values, 's'), 0);
    if (Number.isNaN(skipFields) || Number.isNaN(skipChars)) {
        return err('uniq: invalid number\n', 2);
    }
    const files = scanned.operands.slice(0, 2);
    const sources: NamedText[] = [];
    if (files.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
    } else {
        const info = readOne(ctx, files[0]);
        if (info.text === undefined) return err(`uniq: ${files[0]}: No such file or directory\n`, 1);
        sources.push({ name: files[0], text: info.text });
    }

    const compareKey = (line: string): string => {
        let text = line;
        if (skipFields > 0) {
            const trimmed = text.replace(/^[ \t]+/, '');
            const parts = trimmed.split(/[ \t]+/);
            text = parts.slice(skipFields).join(' ');
        }
        if (skipChars > 0) text = text.slice(skipChars);
        return ignoreCase ? text.toLowerCase() : text;
    };

    if (files.length >= 2) {
        const produced = uniqBody(splitLines(sources[0].text), count, repeated, unrepeated, compareKey);
        ctx.fs.writeFile(atPath(ctx, files[1]), produced);
        return out('');
    }
    let body = uniqBody(splitLines(sources[0].text), count, repeated, unrepeated, compareKey);
    const unterminated = sources[0].text !== '' && !sources[0].text.endsWith('\n');
    if (unterminated && body.endsWith('\n')) body = body.slice(0, -1);
    return out(body);
};

function uniqBody(
    lines: string[],
    count: boolean,
    repeated: boolean,
    unrepeated: boolean,
    compareKey: (line: string) => string
): string {
    let stdoutText = '';
    let index = 0;
    while (index < lines.length) {
        const key = compareKey(lines[index]);
        let run = 1;
        while (index + run < lines.length && compareKey(lines[index + run]) === key) run++;
        if (count) {
            stdoutText += String(run).padStart(4, ' ') + ' ' + lines[index] + '\n';
        } else if (repeated) {
            if (run > 1) stdoutText += lines[index] + '\n';
        } else if (unrepeated) {
            if (run === 1) stdoutText += lines[index] + '\n';
        } else {
            stdoutText += lines[index] + '\n';
        }
        index += run;
    }
    return stdoutText === '' ? '' : stdoutText;
}


/* ================================================================== *
 * wc
 * ================================================================== */

const cmdWc: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['c', 'l', 'm', 'w', 'L']), valued: new Set() };
    const scanned = scanFlags(ctx.args, 0, spec);
    const flags = scanned.flags;
    const files = scanned.operands;
    const sources: NamedText[] = [];
    if (files.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
    } else {
        for (const file of files) {
            if (file === '-') {
                sources.push({ name: '-', text: ctx.input ?? '' });
                continue;
            }
            const info = readOne(ctx, file);
            if (info.text === undefined) return err(`wc: ${file}: open: No such file or directory\n`, 1);
            sources.push({ name: file, text: info.text });
        }
    }
    const showAll = flags.length === 0;
    const showLines = showAll || hasFlag(flags, 'l');
    const showWords = showAll || hasFlag(flags, 'w');
    const showChars = showAll || hasFlag(flags, 'c');
    const showMultibyte = hasFlag(flags, 'm');

    const totals = { lines: 0, words: 0, bytes: 0, chars: 0, longest: 0 };
    const rows: string[] = [];
    for (const source of sources) {
        const text = source.text;
        const lines = (text.match(/\n/g) ?? []).length;
        const words = (text.match(/[^\s]+/g) ?? []).length;
        const bytes = byteLength(text);
        const chars = Array.from(text).length;
        let longest = 0;
        for (const line of splitLines(text)) longest = Math.max(longest, Array.from(line).length);
        totals.lines += lines;
        totals.words += words;
        totals.bytes += bytes;
        totals.chars += chars;
        totals.longest = Math.max(totals.longest, longest);
        const cells: string[] = [];
        if (showLines) cells.push(String(lines).padStart(8, ' '));
        if (showWords) cells.push(String(words).padStart(8, ' '));
        if (showChars) cells.push(String(bytes).padStart(8, ' '));
        if (showMultibyte) cells.push(String(chars).padStart(8, ' '));
        if (hasFlag(flags, 'L')) cells.push(String(longest).padStart(8, ' '));
        const label = source.name === '-' ? '' : ' ' + source.name;
        rows.push(cells.join('') + label);
    }
    if (sources.length > 1) {
        const cells: string[] = [];
        if (showLines) cells.push(String(totals.lines).padStart(8, ' '));
        if (showWords) cells.push(String(totals.words).padStart(8, ' '));
        if (showChars) cells.push(String(totals.bytes).padStart(8, ' '));
        if (showMultibyte) cells.push(String(totals.chars).padStart(8, ' '));
        if (hasFlag(flags, 'L')) cells.push(String(totals.longest).padStart(8, ' '));
        rows.push(cells.join('') + ' total');
    }
    let stdoutText = rows.join('\n');
    if (stdoutText !== '') stdoutText += '\n';
    return out(stdoutText);
};

/* ================================================================== *
 * head / tail
 * ================================================================== */

function headTailSources(ctx: CommandContext, files: string[], name: string): NamedText[] | CommandResult {
    const sources: NamedText[] = [];
    if (files.length === 0) {
        sources.push({ name: '-', text: ctx.input ?? '' });
        return sources;
    }
    for (const file of files) {
        if (file === '-') {
            sources.push({ name: '-', text: ctx.input ?? '' });
            continue;
        }
        const info = readOne(ctx, file);
        if (info.text === undefined) {
            return err(`${name}: ${file}: No such file or directory\n`, 1);
        }
        sources.push({ name: file, text: info.text });
    }
    return sources;
}

const cmdHead: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['q', 'v']), valued: new Set(['n', 'c']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    let count: number | null = null;
    let mode = 'lines';
    const explicit: string[] = [];
    for (const value of scanned.values['n'] ?? []) {
        count = parseCount(value, 10);
        mode = 'lines';
        explicit.push(value);
    }
    for (const value of scanned.values['c'] ?? []) {
        count = parseCount(value, 0);
        mode = 'bytes';
    }
    if (scanned.operands.length > 0 && /^-\d+$/.test(scanned.operands[0])) {
        count = parseCount(scanned.operands[0].slice(1), 10);
        mode = 'lines';
        scanned.operands.shift();
    }
    if (scanned.operands.length > 0 && /^\+\d+$/.test(scanned.operands[0])) {
        return err(`head: illegal option -- ${scanned.operands[0]}\n`, 2);
    }
    if (count === null) count = 10;
    if (Number.isNaN(count) || count <= 0) {
        return err(`head: illegal ${mode === 'bytes' ? 'byte' : 'line'} count -- ${scanned.values['n'] ?? scanned.values['c'] ?? ['']}\n`, 1);
    }

    const sources = headTailSources(ctx, scanned.operands, 'head');
    if (!Array.isArray(sources)) return sources;
    const showNames = hasFlag(scanned.flags, 'v') || (sources.length > 1 && !hasFlag(scanned.flags, 'q'));
    let stdoutText = '';
    for (let s = 0; s < sources.length; s++) {
        const source = sources[s];
        if (showNames) stdoutText += (s > 0 ? '\n' : '') + `==> ${source.name} <==\n`;
        if (mode === 'lines') {
            const all = splitLines(source.text);
            stdoutText += joinLines(all.slice(0, count));
            if (count >= all.length && source.text !== '' && !source.text.endsWith('\n')) {
                stdoutText = stdoutText.slice(0, -1);
            }
        } else {
            stdoutText += decodeUtf8(utf8Bytes(source.text).slice(0, count));
        }
    }
    return out(stdoutText);
};

const cmdTail: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['q', 'v', 'r', 'f', 'F']), valued: new Set(['n', 'c']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    let count: number | null = null;
    let mode = 'lines';
    for (const value of scanned.values['n'] ?? []) {
        count = parseCount(value, 10);
        mode = 'lines';
    }
    for (const value of scanned.values['c'] ?? []) {
        count = parseCount(value, 0);
        mode = 'bytes';
    }
    if (scanned.operands.length > 0 && /^-\d+$/.test(scanned.operands[0])) {
        count = parseCount(scanned.operands[0].slice(1), 10);
        mode = 'lines';
        scanned.operands.shift();
    }
    if (scanned.operands.length > 0 && /^\+\d+$/.test(scanned.operands[0])) {
        const start = parseInt(scanned.operands[0].slice(1), 10);
        scanned.operands.shift();
        const sources = headTailSources(ctx, scanned.operands, 'tail');
        if (!Array.isArray(sources)) return sources;
        let stdoutText = '';
        for (const source of sources) {
            const lines = splitLines(source.text);
            stdoutText += joinLines(lines.slice(Math.max(0, start - 1)));
        }
        return out(stdoutText);
    }
    if (count === null) count = 10;
    if (Number.isNaN(count) || count < 0) return err(`tail: illegal offset\n`, 1);

    const sources = headTailSources(ctx, scanned.operands, 'tail');
    if (!Array.isArray(sources)) return sources;
    const showNames = hasFlag(scanned.flags, 'v') || (sources.length > 1 && !hasFlag(scanned.flags, 'q'));
    let stdoutText = '';
    for (let s = 0; s < sources.length; s++) {
        const source = sources[s];
        if (showNames) stdoutText += (s > 0 ? '\n' : '') + `==> ${source.name} <==\n`;
        if (mode === 'lines') {
            const lines = splitLines(source.text);
            stdoutText += joinLines(count === 0 ? [] : lines.slice(Math.max(0, lines.length - count)));
            if (count >= 1 && source.text !== '' && !source.text.endsWith('\n')) {
                stdoutText = stdoutText.slice(0, -1);
            }
        } else {
            const bytes = utf8Bytes(source.text);
            stdoutText += decodeUtf8(count === 0 ? [] : bytes.slice(Math.max(0, bytes.length - count)));
        }
    }
    return out(stdoutText);
};

/* ================================================================== *
 * comm
 * ================================================================== */

const cmdComm: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['1', '2', '3', 'i']), valued: new Set() };
    const scanned = scanFlags(ctx.args, 0, spec);
    const show = [!hasFlag(scanned.flags, '1'), !hasFlag(scanned.flags, '2'), !hasFlag(scanned.flags, '3')];
    const ignoreCase = hasFlag(scanned.flags, 'i');
    if (scanned.operands.length < 2) {
        return err(COMM_USAGE, 1);
    }
    const first = readOne(ctx, scanned.operands[0]);
    const second = readOne(ctx, scanned.operands[1]);
    if (first.text === undefined) return err(`comm: ${scanned.operands[0]}: No such file or directory\n`, 1);
    if (second.text === undefined) return err(`comm: ${scanned.operands[1]}: No such file or directory\n`, 1);
    const a = splitLines(first.text);
    const b = splitLines(second.text);
    const norm = (line: string): string => (ignoreCase ? line.toLowerCase() : line);
    let i = 0;
    let j = 0;
    let stdoutText = '';
    while (i < a.length || j < b.length) {
        let cmp: number;
        if (i >= a.length) cmp = 1;
        else if (j >= b.length) cmp = -1;
        else cmp = byteCompare(norm(a[i]), norm(b[j]));
        if (cmp === 0) {
            if (show[2]) stdoutText = emitCommLine(stdoutText, a[i], 2, show);
            i++;
            j++;
            continue;
        }
        if (cmp < 0) {
            if (show[0]) stdoutText = emitCommLine(stdoutText, a[i], 0, show);
            i++;
            continue;
        }
        if (show[1]) stdoutText = emitCommLine(stdoutText, b[j], 1, show);
        j++;
    }
    return out(stdoutText);
};

function emitCommLine(acc: string, line: string, column: number, show: boolean[]): string {
    let tabs = 0;
    for (let c = 0; c < column; c++) if (show[c]) tabs++;
    return acc + '\t'.repeat(tabs) + line + '\n';
}

/* ================================================================== *
 * join
 * ================================================================== */

const cmdJoin: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = {
        plain: new Set(['i', 'a', 'v']),
        valued: new Set(['1', '2', 'j', 'e', 'o', 't']),
    };
    const args = ctx.args;
    let field1 = 1;
    let field2 = 1;
    let empty = '';
    let ignoreCase = false;
    let sep: string | null = null;
    let outputList: string | null = null;
    let unpairable: number[] = [];
    const files: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg.length > 1 && arg[0] === '-') {
            const body = arg.slice(1);
            let j = 0;
            for (; j < body.length; j++) {
                const ch = body[j];
                const takeValue = (): string => {
                    if (j + 1 < body.length) {
                        const value = body.slice(j + 1);
                        j = body.length;
                        return value;
                    }
                    return args[++i] ?? '';
                };
                if (ch === '1') {
                    field1 = parseInt(takeValue(), 10);
                    continue;
                }
                if (ch === '2') {
                    field2 = parseInt(takeValue(), 10);
                    continue;
                }
                if (ch === 'j') {
                    field1 = field2 = parseInt(takeValue(), 10);
                    continue;
                }
                if (ch === 'e') {
                    empty = takeValue();
                    continue;
                }
                if (ch === 'o') {
                    outputList = takeValue();
                    continue;
                }
                if (ch === 't') {
                    const value = takeValue();
                    sep = value === '\\t' ? '\t' : value.slice(0, 1);
                    continue;
                }
                if (ch === 'i') {
                    ignoreCase = true;
                    continue;
                }
                if (ch === 'a' || ch === 'v') {
                    const value = takeValue();
                    const which = parseInt(value, 10);
                    if (which === 1 || which === 2) {
                        if (ch === 'a') unpairable.push(which);
                        else unpairable.push(-which);
                    }
                    continue;
                }
                return err(`join: illegal option -- ${ch}\n`, 2);
            }
            continue;
        }
        break;
    }
    for (; i < args.length; i++) files.push(args[i]);

    if (files.length < 2) {
        return err(
            JOIN_USAGE,
            1
        );
    }
    const first = readOne(ctx, files[0]);
    const second = readOne(ctx, files[1]);
    if (first.text === undefined) return err(`join: ${files[0]}: No such file or directory\n`, 1);
    if (second.text === undefined) return err(`join: ${files[1]}: No such file or directory\n`, 1);

    const splitLine = (line: string): string[] =>
        sep === null ? line.replace(/^[ \t]+/, '').split(/[ \t]+/) : line.split(sep);
    const rowsA = splitLines(first.text).map(splitLine);
    const rowsB = splitLines(second.text).map(splitLine);
    const keyOf = (row: string[], field: number): string => {
        const value = row[field - 1] ?? '';
        return ignoreCase ? value.toLowerCase() : value;
    };

    const outputSpec: { file: number; field: number }[] | null = outputList
        ? outputList.split(/[\s,]+/).filter(Boolean).map((item) => {
              const parts = item.split('.');
              return { file: parseInt(parts[0], 10), field: parts.length > 1 ? parseInt(parts[1], 10) : 0 };
          })
        : null;

    let stdoutText = '';
    const emittedA = new Set<number>();
    const emittedB = new Set<number>();
    const only1 = unpairable.indexOf(-1) >= 0;
    const only2 = unpairable.indexOf(-2) >= 0;
    const all1 = unpairable.indexOf(1) >= 0;
    const all2 = unpairable.indexOf(2) >= 0;
    for (let ia = 0; ia < rowsA.length; ia++) {
        const key = keyOf(rowsA[ia], field1);
        let matched = false;
        for (let ib = 0; ib < rowsB.length; ib++) {
            if (keyOf(rowsB[ib], field2) !== key) continue;
            matched = true;
            emittedB.add(ib);
            if (!only1 && !only2) {
                stdoutText += buildJoinOutput(outputSpec, rowsA[ia], rowsB[ib], field1, field2, empty) + '\n';
            }
        }
        if (matched) continue;
        if (all1 || only1) {
            stdoutText += buildJoinOutput(outputSpec, rowsA[ia], null, field1, field2, empty) + '\n';
        }
    }
    for (let ib = 0; ib < rowsB.length; ib++) {
        if (emittedB.has(ib)) continue;
        if (all2 || only2) {
            stdoutText += buildJoinOutput(outputSpec, null, rowsB[ib], field1, field2, empty) + '\n';
        }
    }
    void emittedA;
    return out(stdoutText);
};

function buildJoinOutput(
    spec: { file: number; field: number }[] | null,
    rowA: string[] | null,
    rowB: string[] | null,
    field1: number,
    field2: number,
    empty: string
): string {
    if (spec) {
        const cells: string[] = [];
        for (const item of spec) {
            const row = item.file === 0 ? (rowA ?? rowB ?? []) : item.file === 1 ? rowA ?? [] : rowB ?? [];
            const value = item.field === 0 ? (rowA ?? rowB ?? [])[(item.file === 2 ? field2 : field1) - 1] ?? '' : row[item.field - 1] ?? '';
            cells.push(value === '' && empty !== '' ? empty : value);
        }
        return cells.join(' ');
    }
    const cells: string[] = [];
    const joinField = rowA ? rowA[field1 - 1] ?? '' : (rowB ?? [])[field2 - 1] ?? '';
    cells.push(joinField);
    if (rowA) {
        for (let i = 0; i < rowA.length; i++) {
            if (i === field1 - 1) continue;
            cells.push(rowA[i] === '' && empty !== '' ? empty : rowA[i]);
        }
    }
    if (rowB) {
        for (let i = 0; i < rowB.length; i++) {
            if (i === field2 - 1) continue;
            cells.push(rowB[i] === '' && empty !== '' ? empty : rowB[i]);
        }
    }
    return cells.join(' ');
}

/* ================================================================== *
 * diff
 * ================================================================== */

type DiffOp = { op: '=' | '-' | '+'; ai: number; bi: number };

/** Myers' O(ND) diff; returns the edit script over the two line arrays. */
function diffScript(a: string[], b: string[], eq: (x: string, y: string) => boolean): DiffOp[] {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 2;
    const size = 2 * max + 5;
    const v = new Int32Array(size);
    const trace: Int32Array[] = [];
    v[offset + 1] = 0;
    let found = false;
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
            else x = v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && eq(a[x], b[y])) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
        if (found) break;
    }
    const edits: DiffOp[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
        else prevK = k - 1;
        const prevX = vd[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            edits.push({ op: '=', ai: x - 1, bi: y - 1 });
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX) edits.push({ op: '+', ai: x, bi: y - 1 });
            else edits.push({ op: '-', ai: x - 1, bi: y });
        }
        x = prevX;
        y = prevY;
    }
    edits.reverse();
    return edits;
}

interface DiffHunk {
    aStart: number;
    bStart: number;
    ops: DiffOp[];
    dels: number[];
    adds: number[];
}

function groupHunks(edits: DiffOp[], aLen: number, bLen: number, context: number): DiffHunk[] {
    const changed: boolean[] = edits.map((e) => e.op !== '=');
    const keep: boolean[] = new Array(edits.length).fill(false);
    for (let i = 0; i < edits.length; i++) {
        if (!changed[i]) continue;
        for (let j = Math.max(0, i - context); j <= Math.min(edits.length - 1, i + context); j++) keep[j] = true;
    }
    const hunks: DiffHunk[] = [];
    let i = 0;
    let aIndex = 0;
    let bIndex = 0;
    while (i < edits.length) {
        if (!keep[i]) {
            if (edits[i].op === '=') {
                aIndex++;
                bIndex++;
            } else if (edits[i].op === '-') aIndex++;
            else bIndex++;
            i++;
            continue;
        }
        const start = i;
        let j = i;
        while (j < edits.length && keep[j]) j++;
        while (j < edits.length && edits[j].op === '=' && (keep[j] ?? false)) j++;
        const dels: number[] = [];
        const adds: number[] = [];
        const ops: DiffOp[] = [];
        const aStart = aIndex;
        const bStart = bIndex;
        for (let k = start; k < j; k++) {
            const e = edits[k];
            if (e.op === '=') {
                ops.push({ op: '=', ai: aIndex, bi: bIndex });
                aIndex++;
                bIndex++;
            } else if (e.op === '-') {
                ops.push({ op: '-', ai: aIndex, bi: bIndex });
                dels.push(aIndex);
                aIndex++;
            } else {
                ops.push({ op: '+', ai: aIndex, bi: bIndex });
                adds.push(bIndex);
                bIndex++;
            }
        }
        hunks.push({ aStart, bStart, ops, dels, adds });
        i = j;
    }
    void aLen;
    void bLen;
    return hunks;
}

function formatRange(start: number, count: number): string {
    if (count === 0) return String(start - 1);
    if (count === 1) return String(start);
    return `${start},${start + count - 1}`;
}

function formatUnifiedRange(start: number, count: number): string {
    if (count === 0) return `${start - 1},0`;
    if (count === 1) return String(start);
    return `${start},${count}`;
}

function diffNormal(a: string[], b: string[], hunks: DiffHunk[], aNoNewline: boolean, bNoNewline: boolean): string {
    let text = '';
    for (const hunk of hunks) {
        const aStart = hunk.aStart + 1;
        const bStart = hunk.bStart + 1;
        if (hunk.dels.length > 0 && hunk.adds.length > 0) {
            text += `${formatRange(aStart, hunk.dels.length)}c${formatRange(bStart, hunk.adds.length)}\n`;
        } else if (hunk.dels.length > 0) {
            text += `${formatRange(aStart, hunk.dels.length)}d${bStart - 1}\n`;
        } else {
            text += `${aStart - 1}a${formatRange(bStart, hunk.adds.length)}\n`;
        }
        for (const index of hunk.dels) {
            text += '< ' + a[index] + '\n';
            if (aNoNewline && index === a.length - 1) text += '\\ No newline at end of file\n';
        }
        if (hunk.dels.length > 0 && hunk.adds.length > 0) text += '---\n';
        for (const index of hunk.adds) {
            text += '> ' + b[index] + '\n';
            if (bNoNewline && index === b.length - 1) text += '\\ No newline at end of file\n';
        }
    }
    return text;
}

function diffContextLines(
    a: string[],
    b: string[],
    hunks: DiffHunk[],
    name1: string,
    name2: string,
    style: 'unified' | 'context',
    aNoNewline: boolean,
    bNoNewline: boolean
): string {
    let text = '';
    if (style === 'unified') {
        text += `--- ${name1}\n`;
        text += `+++ ${name2}\n`;
    } else {
        text += `*** ${name1}\n`;
        text += `--- ${name2}\n`;
    }
    for (const hunk of hunks) {
        let fromCount = 0;
        let toCount = 0;
        for (const op of hunk.ops) {
            if (op.op !== '+') fromCount++;
            if (op.op !== '-') toCount++;
        }
        if (style === 'unified') {
            text += `@@ -${formatUnifiedRange(hunk.aStart + 1, fromCount)} +${formatUnifiedRange(hunk.bStart + 1, toCount)} @@\n`;
            for (const op of hunk.ops) {
                if (op.op === '=') text += ' ' + a[op.ai] + '\n';
                else if (op.op === '-') {
                    text += '-' + a[op.ai] + '\n';
                    if (aNoNewline && op.ai === a.length - 1) text += '\\ No newline at end of file\n';
                } else {
                    text += '+' + b[op.bi] + '\n';
                    if (bNoNewline && op.bi === b.length - 1) text += '\\ No newline at end of file\n';
                }
            }
        } else {
            text += '***************\n';
            text += `*** ${formatUnifiedRange(hunk.aStart + 1, fromCount)} ****\n`;
            const paired = Math.min(hunk.dels.length, hunk.adds.length);
            let delSeen = 0;
            for (const op of hunk.ops) {
                if (op.op === '=') text += '  ' + a[op.ai] + '\n';
                else if (op.op === '-') {
                    text += (delSeen++ < paired ? '! ' : '- ') + a[op.ai] + '\n';
                    if (aNoNewline && op.ai === a.length - 1) text += '\\ No newline at end of file\n';
                }
            }
            text += `--- ${formatUnifiedRange(hunk.bStart + 1, toCount)} ----\n`;
            let addSeen = 0;
            for (const op of hunk.ops) {
                if (op.op === '=') text += '  ' + b[op.bi] + '\n';
                else if (op.op === '+') {
                    text += (addSeen++ < paired ? '! ' : '+ ') + b[op.bi] + '\n';
                    if (bNoNewline && op.bi === b.length - 1) text += '\\ No newline at end of file\n';
                }
            }
        }
    }
    return text;
}

function diffEdScript(a: string[], b: string[], hunks: DiffHunk[]): string {
    let text = '';
    for (const hunk of hunks) {
        const aStart = hunk.aStart + 1;
        if (hunk.dels.length > 0 && hunk.adds.length > 0) {
            text += `${formatRange(aStart, hunk.dels.length)}c\n`;
            for (const index of hunk.adds) text += b[index] + '\n';
            text += '.\n';
        } else if (hunk.dels.length > 0) {
            text += `${formatRange(aStart, hunk.dels.length)}d\n`;
        } else {
            text += `${aStart - 1}a\n`;
            for (const index of hunk.adds) text += b[index] + '\n';
            text += '.\n';
        }
    }
    return text;
}

const cmdDiff: ShellCommand = (ctx: CommandContext): CommandResult => {
    const args = ctx.args;
    const flags: string[] = [];
    const values: Record<string, string[]> = {};
    const operands: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg.length > 1 && arg[0] === '-' && arg[1] !== '-') {
            const body = arg.slice(1);
            let j = 0;
            for (; j < body.length; j++) {
                const ch = body[j];
                const take = (): string => {
                    if (j + 1 < body.length) {
                        const value = body.slice(j + 1);
                        j = body.length;
                        return value;
                    }
                    return args[++i] ?? '';
                };
                if (ch === 'U' || ch === 'C' || ch === 'L' || ch === 'D') {
                    (values[ch] = values[ch] ?? []).push(take());
                    continue;
                }
                if ('iwpNarqsteucd'.indexOf(ch) >= 0) {
                    flags.push(ch);
                    continue;
                }
                return err(`diff: illegal option -- ${ch}\n`, 2);
            }
            continue;
        }
        if (arg.length > 2 && arg[0] === '-' && arg[1] === '-') {
            const name = arg.slice(2);
            if (name === 'brief') {
                flags.push('q');
                continue;
            }
            if (name === 'recursive') {
                flags.push('r');
                continue;
            }
            if (name === 'ignore-case') {
                flags.push('i');
                continue;
            }
            if (name === 'new-file') {
                flags.push('N');
                continue;
            }
            if (name === 'unified' || name === 'context' || name === 'text') {
                flags.push(name === 'unified' ? 'u' : name === 'context' ? 'c' : 'a');
                continue;
            }
            return err(`diff: unrecognized option \`${arg}'\n`, 2);
        }
        break;
    }
    for (; i < args.length; i++) operands.push(args[i]);

    if (operands.length < 2) {
        return err(
            DIFF_USAGE,
            2
        );
    }
    const unified = hasFlag(flags, 'u') || 'U' in values;
    const contextStyle = hasFlag(flags, 'c') || 'C' in values;
    const edStyle = hasFlag(flags, 'e');
    const ignoreCase = hasFlag(flags, 'i');
    const ignoreBlanks = hasFlag(flags, 'B');
    const ignoreWhite = hasFlag(flags, 'w');
    const brief = hasFlag(flags, 'q') || hasFlag(flags, 's');
    const recursive = hasFlag(flags, 'r');
    const newFile = hasFlag(flags, 'N');
    let contextLines = 3;
    if ('U' in values) contextLines = parseCount(lastValue(values, 'U'), 3);
    if ('C' in values) contextLines = parseCount(lastValue(values, 'C'), 3);
    const labels = values['L'] ?? [];

    const compareText = (textA: string, textB: string, name1: string, name2: string): { text: string; same: boolean } => {
        let a = splitLines(textA);
        let b = splitLines(textB);
        const noNewlineA = textA !== '' && !textA.endsWith('\n');
        const noNewlineB = textB !== '' && !textB.endsWith('\n');
        const norm = (line: string): string => {
            let value = line;
            if (ignoreWhite) value = value.replace(/\s+/g, ' ').replace(/^ +/, '').replace(/ +$/, '');
            if (ignoreCase) value = value.toLowerCase();
            return value;
        };
        if (unified || contextStyle) {
            const edits = diffScript(a, b, (x, y) => norm(x) === norm(y));
            let hunks = groupHunks(edits, a.length, b.length, contextLines);
            if (ignoreBlanks) {
                hunks = hunks.filter(
                    (hunk) =>
                        !(
                            hunk.dels.every((idx) => a[idx].trim() === '') &&
                            hunk.adds.every((idx) => b[idx].trim() === '')
                        )
                );
            }
            if (hunks.length === 0) return { text: '', same: true };
            return {
                text: diffContextLines(a, b, hunks, name1, name2, unified ? 'unified' : 'context', noNewlineA, noNewlineB),
                same: false,
            };
        }
        const edits = diffScript(a, b, (x, y) => norm(x) === norm(y));
        let hunks = groupHunks(edits, a.length, b.length, 0);
        if (ignoreBlanks) {
            hunks = hunks.filter(
                (hunk) =>
                    !(hunk.dels.every((idx) => a[idx].trim() === '') && hunk.adds.every((idx) => b[idx].trim() === ''))
            );
        }
        if (hunks.length === 0) return { text: '', same: true };
        const body = edStyle
            ? diffEdScript(a, b, hunks.slice().reverse())
            : diffNormal(a, b, hunks, noNewlineA, noNewlineB);
        return { text: body, same: false };
    };

    const name1 = labels[0] ?? operands[0];
    const name2 = labels[1] ?? operands[1];

    const loadPair = (
        left: string,
        right: string
    ): { a: string | undefined; b: string | undefined; dirA: boolean; dirB: boolean } => {
        const infoA = readOne(ctx, left);
        const infoB = readOne(ctx, right);
        return { a: infoA.text, b: infoB.text, dirA: infoA.isDir, dirB: infoB.isDir };
    };

    if (recursive) {
        const { dirA, dirB } = loadPair(operands[0], operands[1]);
        let stdoutText = '';
        let differ = false;
        if (dirA && dirB) {
            const namesA = new Set((ctx.fs.readdirNames?.(atPath(ctx, operands[0])) ?? safeListDirectory(ctx, atPath(ctx, operands[0]))));
            const namesB = new Set((ctx.fs.readdirNames?.(atPath(ctx, operands[1])) ?? safeListDirectory(ctx, atPath(ctx, operands[1]))));
            const all = Array.from(new Set([...Array.from(namesA), ...Array.from(namesB)])).sort();
            for (const name of all) {
                const left = (operands[0].endsWith('/') ? operands[0] : operands[0] + '/') + name;
                const right = (operands[1].endsWith('/') ? operands[1] : operands[1] + '/') + name;
                const infoA = readOne(ctx, left);
                const infoB = readOne(ctx, right);
                if (infoA.isDir && infoB.isDir) {
                    stdoutText += `Common subdirectories: ${left} and ${right}\n`;
                    continue;
                }
                if (!namesA.has(name)) {
                    stdoutText += `Only in ${operands[1]}: ${name}\n`;
                    differ = true;
                    continue;
                }
                if (!namesB.has(name)) {
                    stdoutText += `Only in ${operands[0]}: ${name}\n`;
                    differ = true;
                    continue;
                }
                const result = compareText(infoA.text ?? '', infoB.text ?? '', left, right);
                if (!result.same) {
                    differ = true;
                    if (!brief) stdoutText += result.text.replace(/^(---|\+\+\+|\*\*\*) .*\n/gm, (m) => m);
                }
            }
            return { stdout: stdoutText, stderr: '', exitCode: differ ? 1 : 0 };
        }
    }

    const pair = loadPair(operands[0], operands[1]);
    let leftName = operands[0];
    let rightName = operands[1];
    if (pair.dirA && !pair.dirB) {
        const base = operands[1].split('/').pop() as string;
        leftName = (operands[0].endsWith('/') ? operands[0] : operands[0] + '/') + base;
    } else if (!pair.dirA && pair.dirB) {
        const base = operands[0].split('/').pop() as string;
        rightName = (operands[1].endsWith('/') ? operands[1] : operands[1] + '/') + base;
    }
    const resolved =
        pair.dirA && !pair.dirB
            ? { a: readOne(ctx, leftName).text, b: pair.b }
            : !pair.dirA && pair.dirB
              ? { a: pair.a, b: readOne(ctx, rightName).text }
              : { a: pair.a, b: pair.b };
    if (resolved.a === undefined && !newFile) return err(`diff: ${leftName}: No such file or directory\n`, 2);
    if (resolved.b === undefined && !newFile) return err(`diff: ${rightName}: No such file or directory\n`, 2);
    if (pair.dirA && pair.dirB) {
        return err(`diff: ${operands[0]}: Is a directory\n`, 2);
    }
    const result = compareText(resolved.a ?? '', resolved.b ?? '', labels[0] ?? leftName, labels[1] ?? rightName);
    if (result.same) return out('');
    if (brief) return { stdout: `Files ${labels[0] ?? leftName} and ${labels[1] ?? rightName} differ\n`, stderr: '', exitCode: 1 };
    return { stdout: result.text, stderr: '', exitCode: 1 };
};

/* ================================================================== *
 * fmt
 * ================================================================== */

const cmdFmt: ShellCommand = (ctx: CommandContext): CommandResult => {
    const spec: FlagSpec = { plain: new Set(['s', 'c', 'u']), valued: new Set(['w', 'p']) };
    const scanned = scanFlags(ctx.args, 0, spec);
    let width = 66;
    const widthArg = lastValue(scanned.values, 'w');
    if (widthArg !== undefined) {
        width = parseCount(widthArg, 66);
        if (Number.isNaN(width) || width <= 0) return err(`fmt: invalid width\n`, 2);
    }
    const splitOnly = hasFlag(scanned.flags, 's');
    void splitOnly;
    let sources: NamedText[];
    try {
        sources = inputText({ ...ctx, args: scanned.operands });
    } catch (e) {
        return err(`fmt: ${(e as Error).message}\n`, 2);
    }

    let stdoutText = '';
    for (const source of sources) {
        const lines = splitLines(source.text);
        let paragraph: string[] = [];
        const flush = (): void => {
            if (paragraph.length === 0) return;
            const words: string[] = [];
            for (const line of paragraph) for (const word of line.split(/\s+/).filter(Boolean)) words.push(word);
            let current = '';
            for (const word of words) {
                if (current === '') {
                    current = word;
                    continue;
                }
                if (current.length + 1 + word.length > width) {
                    stdoutText += current + '\n';
                    current = word;
                    continue;
                }
                current += ' ' + word;
            }
            if (current !== '') stdoutText += current + '\n';
            paragraph = [];
        };
        for (const line of lines) {
            // A line beginning with a blank character is copied through unchanged (BSD fmt).
            if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
                flush();
                stdoutText += line + '\n';
                continue;
            }
            if (line.trim() === '') {
                flush();
                stdoutText += '\n';
                continue;
            }
            paragraph.push(line);
        }
        flush();
    }
    return out(stdoutText);
};

/* ================================================================== *
 * pr
 * ================================================================== */

/** Pad from `fromCol` to `toCol` using tab characters where a tab stop is reached, then spaces. */
function prPadTo(fromCol: number, toCol: number): string {
    let pad = '';
    let col = fromCol;
    for (;;) {
        const next = col + (8 - ((col - 1) % 8));
        if (next > toCol) break;
        pad += '\t';
        col = next;
        if (pad.length > 1000) break;
    }
    if (toCol > col) pad += ' '.repeat(toCol - col);
    return pad;
}

const cmdPr: ShellCommand = (ctx: CommandContext): CommandResult => {
    const args = ctx.args;
    let width = 72;
    let pageLength = 66;
    let header = '';
    let noHeader = false;
    let doubleSpace = false;
    let numbering = false;
    let numberWidth = 5;
    let numberChar: string | null = null;
    let offset = 0;
    let merge = false;
    let across = false;
    let separator: string | null = null;
    let formFeed = false;
    let expandTabs = false;
    let tabStop = 8;
    let columns = 1;
    const files: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            i++;
            break;
        }
        if (arg.length > 1 && arg[0] === '-' && /^[A-Za-z]/.test(arg[1])) {
            const body = arg.slice(1);
            let j = 0;
            for (; j < body.length; j++) {
                const ch = body[j];
                const rest = body.slice(j + 1);
                const endOption = (): void => {
                    j = body.length;
                };
                if (ch === 'w') {
                    width = /^\d/.test(rest) ? parseInt(rest, 10) : parseInt(args[++i] ?? '72', 10);
                    endOption();
                    continue;
                }
                if (ch === 'l') {
                    pageLength = /^\d/.test(rest) ? parseInt(rest, 10) : parseInt(args[++i] ?? '66', 10);
                    endOption();
                    continue;
                }
                if (ch === 'h') {
                    header = rest !== '' ? rest : args[++i] ?? '';
                    endOption();
                    continue;
                }
                if (ch === 'o') {
                    offset = /^\d/.test(rest) ? parseInt(rest, 10) : parseInt(args[++i] ?? '0', 10);
                    endOption();
                    continue;
                }
                if (ch === 'n') {
                    numbering = true;
                    const match = /^(\d*)(.)?/.exec(rest);
                    if (match && match[1] !== '') numberWidth = parseInt(match[1], 10);
                    if (match && match[2]) numberChar = match[2];
                    endOption();
                    continue;
                }
                if (ch === 's') {
                    separator = rest !== '' ? rest : args[++i] ?? '\t';
                    if (separator === '\\t') separator = '\t';
                    endOption();
                    continue;
                }
                if (ch === 'e' || ch === 'i') {
                    expandTabs = true;
                    if (/^\d/.test(rest)) tabStop = parseInt(rest, 10);
                    endOption();
                    continue;
                }
                if (ch === 't') {
                    noHeader = true;
                    continue;
                }
                if (ch === 'd') {
                    doubleSpace = true;
                    continue;
                }
                if (ch === 'm') {
                    merge = true;
                    continue;
                }
                if (ch === 'a') {
                    across = true;
                    continue;
                }
                if (ch === 'f' || ch === 'F') {
                    formFeed = true;
                    continue;
                }
                if (ch === 'r') continue;
                return err(`pr: illegal option -- ${ch}\n`, 2);
            }
            continue;
        }
        if (arg.length > 1 && arg[0] === '-' && /^\d+$/.test(arg.slice(1))) {
            columns = parseInt(arg.slice(1), 10);
            continue;
        }
        break;
    }
    for (; i < args.length; i++) files.push(args[i]);

    let entries: NamedText[];
    try {
        entries = inputText({ ...ctx, args: files });
    } catch (e) {
        return err(`pr: cannot open ${(e as Error).message.replace(/: No such file or directory$/, '')}, No such file or directory\n`, 1);
    }

    const effectiveWidth = Math.max(1, width - offset);
    const expand = (line: string): string => {
        if (!expandTabs) return line;
        let outText = '';
        let col = 0;
        for (const ch of line) {
            if (ch === '\t') {
                const pad = tabStop - (col % tabStop);
                outText += ' '.repeat(pad);
                col += pad;
                continue;
            }
            outText += ch;
            col++;
        }
        return outText;
    };

    const now = new Date();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const stamp = `${monthNames[now.getMonth()]} ${String(now.getDate()).padStart(2, ' ')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${now.getFullYear()}`;
    const title = header !== '' ? header : entries[0]?.name ?? '';

    let stdoutText = '';
    const suppressPagination = noHeader || pageLength <= 10;

    /** Lay a row out across columns, padding each column to `columnWidth`; trailing empties drop out. */
    const layoutRow = (pieces: string[], columnWidth: number): string => {
        let last = pieces.length;
        while (last > 1 && pieces[last - 1] === '') last--;
        pieces = pieces.slice(0, last);
        if (separator !== null) return pieces.join(separator);
        let text = '';
        let col = 1;
        for (let c = 0; c < pieces.length; c++) {
            const target = 1 + c * columnWidth;
            if (c > 0) text += prPadTo(col, target);
            col = target;
            text += pieces[c];
            col += pieces[c].length;
        }
        return text;
    };

    const body: string[] = [];

    if (merge) {
        const columnLines = entries.map((entry) => splitLines(entry.text));
        const count = Math.max(1, columnLines.length);
        const columnWidth = Math.max(1, Math.floor(effectiveWidth / count));
        let height = 0;
        for (const column of columnLines) height = Math.max(height, column.length);
        for (let row = 0; row < height; row++) {
            const pieces = columnLines.map((column) => expand(column[row] ?? ''));
            body.push(layoutRow(pieces, columnWidth));
        }
    } else if (columns > 1) {
        const all = [];
        for (const entry of entries) all.push(...splitLines(entry.text).map(expand));
        const columnWidth = Math.max(1, Math.floor(effectiveWidth / columns));
        const rows = Math.ceil(all.length / columns);
        const perColumn = across ? rows : Math.ceil(all.length / columns);
        for (let row = 0; row < rows; row++) {
            const pieces: string[] = [];
            for (let c = 0; c < columns; c++) {
                const index = across ? row * columns + c : c * perColumn + row;
                pieces.push(all[index] ?? '');
            }
            body.push(layoutRow(pieces, columnWidth));
        }
    } else {
        for (const entry of entries) body.push(...splitLines(entry.text).map(expand));
    }

    if (body.length === 0) return out('');
    const perPage = Math.max(1, pageLength - 10);
    let page = 1;
    for (let start = 0; start < body.length; start += perPage) {
        const chunk = body.slice(start, start + perPage);
        if (!suppressPagination) {
            stdoutText += '\n\n';
            stdoutText += ' '.repeat(offset) + `${stamp} ${title} Page ${page}` + '\n';
            stdoutText += '\n\n';
        }
        for (let k = 0; k < (suppressPagination ? chunk.length : perPage); k++) {
            const line = k < chunk.length ? chunk[k] : '';
            let text = ' '.repeat(offset) + (line.length > effectiveWidth ? line.slice(0, effectiveWidth) : line);
            if (line !== '' && numbering) {
                text = String(start + k + 1).padStart(numberWidth, ' ') + (numberChar ?? '\t') + text;
            }
            stdoutText += text + '\n';
            if (doubleSpace && line !== '') stdoutText += '\n';
        }
        if (!suppressPagination) {
            if (formFeed) stdoutText += '\f';
            else stdoutText += '\n'.repeat(5);
        }
        page++;
    }
    return out(stdoutText);
};

/* ================================================================== *
 * tabs
 * ================================================================== */

const TABS_FORMATS: Record<string, number[]> = {
    a: [1, 10, 16, 36, 72],
    a2: [1, 10, 16, 40, 72],
    c: [1, 8, 12, 16, 20, 55],
    c2: [1, 6, 10, 14, 49],
    c3: [1, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62, 67],
    f: [1, 7, 11, 15, 19, 23],
    p: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61],
    s: [1, 10, 55],
    u: [1, 12, 20, 44],
};

/** The column past which no further tab stop is set when stops repeat at an interval. */
const TABS_MAX_COLUMN = 81;

function tabsRender(stops: number[]): string {
    let text = '\r\x1b[3g';
    let col = 1;
    for (const stop of stops) {
        if (stop < col) continue;
        text += ' '.repeat(stop - col);
        col = stop;
        text += '\x1bH';
    }
    return text + '\r';
}

const cmdTabs: ShellCommand = (ctx: CommandContext): CommandResult => {
    const args = ctx.args;
    let stops: number[] | null = null;
    let margin = 0;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.length > 1 && arg[0] === '-' && /^\d/.test(arg[1])) {
            const step = parseInt(arg.slice(1), 10);
            if (step === 0) {
                stops = [];
                continue;
            }
            stops = [];
            for (let col = 1; col <= TABS_MAX_COLUMN; col += step) stops.push(col);
            continue;
        }
        if (arg.length > 1 && arg[0] === '-') {
            const name = arg.slice(1);
            if (TABS_FORMATS[name] !== undefined) {
                stops = TABS_FORMATS[name].slice();
                continue;
            }
            if (name === 'T') {
                i++;
                continue;
            }
            return err(`tabs: illegal option -- ${name}\n`, 2);
        }
        if (arg.startsWith('+')) {
            margin = parseInt(arg.slice(1), 10);
            if (Number.isNaN(margin)) margin = 10;
            continue;
        }
        stops = [];
        let current = 0;
        for (const part of arg.split(/[,\s]+/).filter(Boolean)) {
            let text = part;
            let relative = false;
            if (text.startsWith('+')) {
                relative = true;
                text = text.slice(1);
            }
            const value = parseInt(text, 10);
            if (!Number.isFinite(value) || value < 1) return err(`tabs: ${arg}: invalid tab stop\n`, 1);
            current = relative ? current + value : value;
            stops.push(current);
        }
    }
    if (stops === null) {
        stops = [];
        for (let col = 1; col <= TABS_MAX_COLUMN; col += 8) stops.push(col);
    }
    if (margin > 0) {
        stops = stops.map((stop) => stop + margin - 1);
    }
    return out(tabsRender(stops));
};

/* ================================================================== *
 * export
 * ================================================================== */

export const COMMANDS: Record<string, ShellCommand> = {
    grep: cmdGrep,
    sed: cmdSed,
    awk: cmdAwk,
    cut: cmdCut,
    sort: cmdSort,
    tr: cmdTr,
    paste: cmdPaste,
    uniq: cmdUniq,
    wc: cmdWc,
    head: cmdHead,
    tail: cmdTail,
    join: cmdJoin,
    comm: cmdComm,
    diff: cmdDiff,
    fmt: cmdFmt,
    pr: cmdPr,
    tabs: cmdTabs,
};
