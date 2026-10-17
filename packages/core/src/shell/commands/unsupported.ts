/**
 * The utilities a browser container cannot have, given a stable, named outcome.
 *
 * Every name this module owns ends one of two ways, and never any other: it runs as a faithful
 * minimal implementation, or it writes one line naming what the container lacks and exits 1.
 * Nothing here exits 127 'Command not found', nothing throws, and nothing reports a success it
 * did not produce.
 *
 *   make      a minimal makefile runner: variables, pattern rules, .PHONY, automatic variables,
 *             missing prerequisites and failing recipes.
 *   bc        an arbitrary-precision calculator: + - * / % ^, scale, sqrt, ibase/obase, arrays,
 *             functions, if/while/for and the -l math library.
 *   openssl   a subset: dgst with md5, sha1, sha224, sha256, sha384 and sha512 (plus -hmac), the
 *             same digests as shorthand commands, rand -hex/-base64 and version.
 *
 * Every other name in UNSUPPORTED is a name the container cannot have; isUnsupported(name) says
 * which of the two outcomes a name gets, and UNSUPPORTED[name] is the reason the report carries.
 * The two sets are disjoint: a name is in COMMANDS or in UNSUPPORTED, never both.
 */
import { createShellState, getRunner, runScript, setRunner } from './builtins';
import type { ShellFs } from './builtins';
import type { CommandContext, CommandResult, ShellCommand } from './types';
import { atPath, inputText } from './types';
import { hmac } from '@noble/hashes/hmac';
import { md5 } from '@noble/hashes/legacy';
import { sha1 } from '@noble/hashes/sha1';
import { sha224, sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';

/* ================================================================== *
 * 0. Shared
 * ================================================================== */

function ok(stdout = ''): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): CommandResult {
    return { stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Collapses `//`, `.` and `..`; `..` at the root stays at the root. */
function norm(path: string): string {
    const out: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (out.length > 0) out.pop();
            continue;
        }
        out.push(part);
    }
    return '/' + out.join('/');
}

/**
 * Resolves a path argument against the working directory. `atPath` already leaves an absolute
 * path alone, so it is used for that half; the relative half is joined here because the file
 * system's own resolvePath does not honour its base argument on every back end.
 */
function at(ctx: CommandContext, path: string): string {
    if (path.startsWith('/')) return atPath(ctx, path);
    const base = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    return norm(base + path);
}

/**
 * The text a command reads: its file arguments, or its standard input when it has none. The
 * arguments are resolved against the working directory before `inputText` reads them, so a
 * relative name means the same thing here as it does to the shell.
 */
function readInputs(ctx: CommandContext, files: string[]): { name: string; text: string }[] {
    const abs = files.map((file) => at(ctx, file));
    const read = inputText({ ...ctx, args: abs });
    if (abs.length === 0) return read;
    return read.map((entry, i) => ({ name: files[i] ?? entry.name, text: entry.text }));
}

/* ================================================================== *
 * 1. make
 * ================================================================== */

interface MakeRule {
    target: string;
    prereqs: string[];
    recipe: string[];
    pattern: boolean;
}

interface MakeVar {
    op: '=' | ':=' | '::=' | '?=' | '+=';
    value: string;
}

interface MakeFile {
    rules: MakeRule[];
    vars: Map<string, MakeVar>;
    phony: Set<string>;
    silent: boolean;
    first: string;
    goal: string | undefined;
    /** Installed when make runs, so `$(wildcard ...)` can list the directory it is running in. */
    glob: ((pattern: string) => string[]) | undefined;
}

/** The makefile functions this runner knows. Anything else stops the run rather than expanding to nothing. */
const MAKE_FUNCTIONS = new Set(['subst', 'patsubst', 'strip', 'wildcard', 'notdir', 'basename', 'dir', 'addprefix', 'addsuffix']);

const MAKE_DIRECTIVES = new Set(['ifeq', 'ifneq', 'ifdef', 'ifndef', 'else', 'endif', 'define', 'endef', 'include', '-include', 'sinclude', 'vpath']);

/** Reads a makefile: rules, variables, special targets and the recipes that belong to each rule. */
function parseMakefile(text: string): MakeFile {
    const file: MakeFile = {
        rules: [],
        vars: new Map(),
        phony: new Set(),
        silent: false,
        first: '',
        goal: undefined,
        glob: undefined
    };
    const lines = text.split('\n');
    let current: MakeRule | null = null;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        while (line.endsWith('\\') && i + 1 < lines.length) {
            const next = lines[++i].replace(/^\t/, '');
            line = line.slice(0, -1) + (current !== null ? '' : ' ') + next;
        }
        if (/^\t/.test(line)) {
            if (current !== null) current.recipe.push(line.slice(1));
            continue;
        }
        current = null;
        const body = line.replace(/(^|[^\\])#.*$/, '$1').trim();
        if (body === '') continue;
        const directive = /^([A-Za-z_-]+)\b/.exec(body);
        if (directive !== null && MAKE_DIRECTIVES.has(directive[1])) {
            throw new Error(`${directive[1]}: not supported by this make`);
        }
        const assignment = /^([A-Za-z_.][^\s:=#]*)\s*(\+=|\?=|::=|:=|=)\s*(.*)$/.exec(body);
        if (assignment !== null) {
            const [, name, op, value] = assignment;
            const previous = file.vars.get(name);
            if (op === '+=' && previous !== undefined) {
                file.vars.set(name, { op: previous.op, value: previous.value + ' ' + value });
            } else if (op === '?=' && previous !== undefined) {
                /* keeps its value */
            } else {
                file.vars.set(name, { op: op as MakeVar['op'], value });
            }
            continue;
        }
        const rule = /^([^:=#]+?)\s*::?\s*([^;]*)(?:;\s*(.*))?$/.exec(body);
        if (rule === null) continue;
        const [, targets, prereqs, inline] = rule;
        const recipe = inline !== undefined && inline.trim() !== '' ? [inline] : [];
        for (const target of targets.trim().split(/\s+/).filter((word) => word !== '')) {
            if (target === '.PHONY') {
                for (const word of prereqs.trim().split(/\s+/).filter((entry) => entry !== '')) file.phony.add(word);
                continue;
            }
            if (target === '.SILENT') {
                if (prereqs.trim() === '') file.silent = true;
                continue;
            }
            if (target === '.DEFAULT_GOAL') {
                const goal = prereqs.trim().split(/\s+/)[0];
                if (goal !== undefined && goal !== '') file.goal = goal;
                continue;
            }
            if (file.first === '') file.first = target;
            const entry: MakeRule = {
                target,
                prereqs: prereqs.trim().split(/\s+/).filter((word) => word !== ''),
                recipe,
                pattern: target.includes('%')
            };
            file.rules.push(entry);
            current = entry;
        }
    }
    return file;
}

/** The automatic variables a recipe is expanded with. */
type Auto = Record<string, string>;

/**
 * Expands `$(NAME)`, `${NAME}` and `$X`. A `=` variable is expanded when it is used, a `:=`
 * variable keeps what it was given; the automatic variables win over both.
 */
function expand(text: string, file: MakeFile, auto: Auto | undefined, seen: Set<string> = new Set()): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch !== '$') {
            out += ch;
            i++;
            continue;
        }
        i++;
        if (i >= text.length) {
            out += '$';
            break;
        }
        if (text[i] === '$') {
            out += '$';
            i++;
            continue;
        }
        let name = '';
        if (text[i] === '(' || text[i] === '{') {
            const open = text[i];
            const close = open === '(' ? ')' : '}';
            let depth = 1;
            let j = i + 1;
            while (j < text.length) {
                if (text[j] === open) depth++;
                else if (text[j] === close) {
                    depth--;
                    if (depth === 0) break;
                }
                name += text[j];
                j++;
            }
            i = Math.min(j + 1, text.length);
            const space = name.indexOf(' ');
            const word = space === -1 ? name : name.slice(0, space);
            if (space !== -1 && MAKE_FUNCTIONS.has(word)) {
                out += callMakeFunction(word, splitArgs(name.slice(space + 1)), file, auto);
                continue;
            }
            if (space !== -1 && !MAKE_FUNCTIONS.has(word) && /^[a-z-]+$/.test(word)) {
                throw new Error(`${word}: unsupported function`);
            }
        } else {
            name = text[i];
            i++;
        }
        if (auto !== undefined && name in auto) {
            out += auto[name];
            continue;
        }
        const variable = file.vars.get(name);
        if (variable === undefined) continue;
        if (variable.op === ':=' || variable.op === '::=') {
            out += variable.value;
            continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        out += expand(variable.value, file, auto, seen);
        seen.delete(name);
    }
    return out;
}

/** Splits the argument list of a makefile function on commas that are not inside a nested call. */
function splitArgs(text: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '{') depth++;
        if (ch === ')' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            args.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    args.push(current);
    return args;
}

function callMakeFunction(name: string, args: string[], file: MakeFile, auto: Auto | undefined): string {
    const each = (text: string): string => expand(text, file, auto);
    switch (name) {
        case 'subst': {
            const [from, to, text] = [each(args[0] ?? ''), each(args[1] ?? ''), each(args[2] ?? '')];
            return text.split(from).join(to);
        }
        case 'patsubst': {
            const [pattern, replacement, text] = [each(args[0] ?? ''), each(args[1] ?? ''), each(args[2] ?? '')];
            const matcher = patternToRegExp(pattern);
            return text
                .split(/\s+/)
                .filter((word) => word !== '')
                .map((word) => {
                    const found = matcher.exec(word);
                    return found === null ? word : replacement.replace(/%/g, found[1] ?? '');
                })
                .join(' ');
        }
        case 'strip':
            return each(args[0] ?? '').split(/\s+/).filter((word) => word !== '').join(' ');
        case 'wildcard': {
            const patterns = each(args[0] ?? '')
                .split(/\s+/)
                .filter((word) => word !== '');
            const list = file.glob;
            if (list === undefined) throw new Error('wildcard: no file system to list');
            return patterns.flatMap((pattern) => list(pattern)).join(' ');
        }
        case 'notdir':
            return each(args[0] ?? '')
                .split(/\s+/)
                .filter((word) => word !== '')
                .map((word) => word.slice(word.lastIndexOf('/') + 1))
                .join(' ');
        case 'basename':
            return each(args[0] ?? '')
                .split(/\s+/)
                .filter((word) => word !== '')
                .map((word) => {
                    const name = word.slice(word.lastIndexOf('/') + 1);
                    const dot = name.lastIndexOf('.');
                    return word.slice(0, word.length - name.length) + (dot === -1 ? name : name.slice(0, dot));
                })
                .join(' ');
        case 'dir':
            return each(args[0] ?? '')
                .split(/\s+/)
                .filter((word) => word !== '')
                .map((word) => {
                    const slash = word.lastIndexOf('/');
                    return slash === -1 ? './' : word.slice(0, slash + 1);
                })
                .join(' ');
        case 'addprefix':
        case 'addsuffix': {
            const [fix, text] = [each(args[0] ?? ''), each(args[1] ?? '')];
            return text
                .split(/\s+/)
                .filter((word) => word !== '')
                .map((word) => (name === 'addprefix' ? fix + word : word + fix))
                .join(' ');
        }
        default:
            throw new Error(`${name}: unsupported function`);
    }
}

function patternToRegExp(pattern: string): RegExp {
    let source = '';
    for (const ch of pattern) {
        if (ch === '%') source += '(.*)';
        else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + source + '$');
}

/** `$(wildcard pattern)`: the entries of the directory in `pattern` that match its last element. */
function globIn(run: MakeRun, pattern: string): string[] {
    const slash = pattern.lastIndexOf('/');
    const dir = slash === -1 ? '' : pattern.slice(0, slash + 1);
    const leaf = slash === -1 ? pattern : pattern.slice(slash + 1);
    const full = dir === '' ? run.dir : norm(run.dir + '/' + dir);
    let entries: string[];
    try {
        entries = run.ctx.fs.listDirectory(full);
    } catch {
        return [];
    }
    const source = leaf
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    const matcher = new RegExp('^' + source + '$');
    return entries.filter((entry) => matcher.test(entry)).sort().map((entry) => dir + entry);
}

interface MakeRun {
    ctx: CommandContext;
    file: MakeFile;
    dir: string;
    view: ShellFs;
    dryRun: boolean;
    silent: boolean;
    stdout: string;
    stderr: string;
}

function mtimeOf(run: MakeRun, path: string): number {
    const full = path.startsWith('/') ? norm(path) : norm(run.dir + '/' + path);
    try {
        return run.ctx.fs.statPath(full)?.mtimeMs ?? -1;
    } catch {
        return -1;
    }
}

function existsOf(run: MakeRun, path: string): boolean {
    const full = path.startsWith('/') ? norm(path) : norm(run.dir + '/' + path);
    try {
        return run.ctx.fs.fileExists(full) || run.ctx.fs.isDirectory(full);
    } catch {
        return false;
    }
}

/**
 * The file system a recipe's shell sees: every path is resolved against the directory make is
 * running in. The shell's own redirections and the host's dispatch both go through it, so a
 * relative name in a recipe means the same thing as a relative name in a rule.
 */
function fsView(ctx: CommandContext, dir: string): ShellFs {
    const at = (path: string): string => (path.startsWith('/') ? norm(path) : norm(dir + '/' + path));
    const guard = <T>(action: () => T, fallback: T): T => {
        try {
            return action();
        } catch {
            return fallback;
        }
    };
    return {
        readFile: (path) => guard(() => ctx.fs.readFile(at(path)), undefined),
        writeFile: (path, content) => ctx.fs.writeFile(at(path), content),
        listDirectory: (path) => guard(() => ctx.fs.listDirectory(at(path)), []),
        isDirectory: (path) => guard(() => ctx.fs.isDirectory(at(path)), false),
        fileExists: (path) => guard(() => ctx.fs.fileExists(at(path)), false),
        createDirectory: (path) => ctx.fs.createDirectory(at(path)),
        deleteFile: (path, recursive) => guard(() => ctx.fs.deleteFile(at(path), recursive), undefined),
        deleteDirectory: (path) => guard(() => ctx.fs.deleteDirectory(at(path)), undefined),
        resolvePath: (path) => at(path)
    };
}

/** A host that wants make's recipes to reach its own dispatch installs this; the shell's runner is used otherwise. */
export type MakeRunner = (words: string[], cwd: string, env: Record<string, string>, input: string | null) => {
    stdout: string;
    stderr: string;
    exitCode: number;
};

let makeRunner: MakeRunner | undefined;

export function setMakeRunner(runner: MakeRunner | undefined): void {
    makeRunner = runner;
}

/** Runs one recipe line in its own shell, in the directory make is running in. */
function runRecipeLine(run: MakeRun, line: string): { stdout: string; stderr: string; exitCode: number } {
    const state = createShellState({ ...run.ctx.env }, run.dir, run.view);
    const host = getRunner();
    setRunner((inner, words, input) => {
        const result = host(inner, words, input);
        if (result.exitCode === 127 && makeRunner !== undefined) {
            return makeRunner(words, inner.cwd, inner.env, input);
        }
        return result;
    });
    try {
        return runScript(state, line);
    } finally {
        setRunner(host);
    }
}

function findRule(file: MakeFile, target: string): { rule: MakeRule; stem: string } | undefined {
    const exact = file.rules.find((rule) => !rule.pattern && rule.target === target);
    if (exact !== undefined) return { rule: exact, stem: '' };
    for (const rule of file.rules) {
        if (!rule.pattern) continue;
        const found = patternToRegExp(rule.target).exec(target);
        if (found !== null) return { rule, stem: found[1] ?? '' };
    }
    return undefined;
}

interface BuildResult {
    error: boolean;
    ran: boolean;
    upToDate: boolean;
    hasRecipe: boolean;
}

function build(run: MakeRun, target: string, stack: string[], neededBy: string | undefined): BuildResult {
    if (stack.includes(target)) {
        run.stderr += `make: Circular dependency dropped: ${[...stack, target].join(' -> ')}\n`;
        return { error: false, ran: false, upToDate: true, hasRecipe: false };
    }
    const found = findRule(run.file, target);
    const phony = run.file.phony.has(target);
    if (found === undefined && !existsOf(run, target)) {
        const suffix = neededBy === undefined ? '' : `, needed by '${neededBy}'`;
        run.stderr += `make: *** No rule to make target '${target}'${suffix}.  Stop.\n`;
        return { error: true, ran: false, upToDate: false, hasRecipe: false };
    }
    const prereqs =
        found === undefined
            ? []
            : expand(found.rule.prereqs.join(' '), run.file, undefined)
                  .split(/\s+/)
                  .filter((word) => word !== '')
                  .map((word) => (found.stem === '' ? word : word.replace(/%/g, found.stem)));
    let ran = false;
    for (const prereq of prereqs) {
        const result = build(run, prereq, [...stack, target], target);
        if (result.error) return { error: true, ran: false, upToDate: false, hasRecipe: false };
        if (result.ran) ran = true;
    }
    if (found === undefined) return { error: false, ran, upToDate: true, hasRecipe: false };
    const recipe = found.rule.recipe;
    if (recipe.length === 0) return { error: false, ran, upToDate: existsOf(run, target), hasRecipe: false };
    if (!phony && existsOf(run, target) && !ran) {
        const targetTime = mtimeOf(run, target);
        const stale = prereqs.some(
            (prereq) => run.file.phony.has(prereq) || !existsOf(run, prereq) || mtimeOf(run, prereq) > targetTime
        );
        if (!stale) return { error: false, ran: false, upToDate: true, hasRecipe: true };
    }
    const stem = found.stem;
    const auto: Auto = {
        '@': target,
        '<': prereqs[0] ?? '',
        '^': [...new Set(prereqs)].join(' '),
        '+': prereqs.join(' '),
        '*': stem,
        '?': prereqs.filter((prereq) => mtimeOf(run, prereq) > mtimeOf(run, target)).join(' ')
    };
    for (const line of recipe) {
        const expanded = expand(line, run.file, auto);
        let text = expanded.replace(/^[ \t]+/, '');
        if (text === '') continue;
        let echo = true;
        let ignore = false;
        let force = false;
        while (text.length > 0 && '@-+'.includes(text[0])) {
            if (text[0] === '@') echo = false;
            else if (text[0] === '-') ignore = true;
            else force = true;
            text = text.slice(1);
        }
        if (echo && !run.silent && !run.file.silent) run.stdout += text + '\n';
        if (run.dryRun && !force) continue;
        const result = runRecipeLine(run, text);
        run.stdout += result.stdout;
        run.stderr += result.stderr;
        if (result.exitCode !== 0) {
            if (ignore) {
                run.stderr += `make: [${target}] Error ${result.exitCode} (ignored)\n`;
                continue;
            }
            run.stderr += `make: *** [${target}] Error ${result.exitCode}\n`;
            return { error: true, ran: true, upToDate: false, hasRecipe: true };
        }
    }
    return { error: false, ran: true, upToDate: false, hasRecipe: true };
}

function cmdMake(ctx: CommandContext): CommandResult {
    let dir = ctx.cwd;
    let name: string | undefined;
    const goals: string[] = [];
    let dryRun = false;
    let silent = false;
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-f' || arg === '--file' || arg === '--makefile') {
            name = ctx.args[++i];
            continue;
        }
        if (arg === '-C' || arg === '--directory') {
            dir = ctx.args[++i];
            continue;
        }
        if (arg.startsWith('-f') && arg.length > 2) {
            name = arg.slice(2);
            continue;
        }
        if (arg.startsWith('-C') && arg.length > 2) {
            dir = arg.slice(2);
            continue;
        }
        if (arg === '-n' || arg === '--just-print' || arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '-s' || arg === '--silent' || arg === '--quiet') {
            silent = true;
            continue;
        }
        if (arg.startsWith('-') && arg !== '-') return fail(`make: invalid option -- '${arg.slice(1)}'`, 2);
        goals.push(arg);
    }
    dir = at(ctx, dir);
    const candidates = name !== undefined ? [at({ ...ctx, cwd: dir }, name)] : ['GNUmakefile', 'makefile', 'Makefile'].map((entry) => norm(dir + '/' + entry));
    const found = candidates.find((candidate) => {
        try {
            return ctx.fs.fileExists(candidate) && !ctx.fs.isDirectory(candidate);
        } catch {
            return false;
        }
    });
    if (found === undefined) {
        if (goals.length === 0) return fail(`make: *** No targets specified and no makefile found.  Stop.`, 2);
        return fail(`make: *** No rule to make target '${goals[0]}'.  Stop.`, 2);
    }
    const text = ctx.fs.readFile(found);
    if (text === undefined) return fail(`make: ${found}: No such file or directory`, 2);
    let file: MakeFile;
    try {
        file = parseMakefile(text);
    } catch (error) {
        return fail(`make: *** ${message(error)}.  Stop.`, 2);
    }
    for (const [key, value] of Object.entries(ctx.env)) {
        if (!file.vars.has(key)) file.vars.set(key, { op: ':=', value });
    }
    const run: MakeRun = {
        ctx,
        file,
        dir,
        view: fsView(ctx, dir),
        dryRun,
        silent,
        stdout: '',
        stderr: ''
    };
    file.glob = (pattern) => globIn(run, pattern);
    const list = goals.length > 0 ? goals : [file.goal ?? file.first];
    if (list.length === 0 || list[0] === '') return fail(`make: *** No targets.  Stop.`, 2);
    for (const goal of list) {
        let result: BuildResult;
        try {
            result = build(run, goal, [], undefined);
        } catch (error) {
            return { stdout: run.stdout, stderr: run.stderr + `make: *** ${message(error)}.  Stop.\n`, exitCode: 2 };
        }
        if (result.error) return { stdout: run.stdout, stderr: run.stderr, exitCode: 2 };
        if (result.upToDate && !result.ran) {
            run.stdout += result.hasRecipe
                ? `make: '${goal}' is up to date.\n`
                : `make: Nothing to be done for '${goal}'.\n`;
        }
    }
    return { stdout: run.stdout, stderr: run.stderr, exitCode: 0 };
}

/* ================================================================== *
 * 2. bc
 * ================================================================== */

interface Num {
    /** The number as an integer scaled by 10^s. */
    n: bigint;
    /** How many digits of n stand after the point. */
    s: number;
}

class BcError extends Error {
    constructor(
        text: string,
        readonly code: number
    ) {
        super(text);
    }
}

class BcSignal extends Error {
    constructor(
        readonly kind: 'return' | 'break' | 'continue' | 'quit',
        readonly value: Num | null
    ) {
        super(kind);
    }
}

function num(n: bigint, s = 0): Num {
    return { n, s };
}

const ZERO = num(0n);

function pow10(k: number): bigint {
    return 10n ** BigInt(k);
}

function rescale(x: Num, s: number): Num {
    if (s === x.s) return x;
    if (s > x.s) return { n: x.n * pow10(s - x.s), s };
    return { n: x.n / pow10(x.s - s), s };
}

function align(a: Num, b: Num): [Num, Num] {
    const s = Math.max(a.s, b.s);
    return [rescale(a, s), rescale(b, s)];
}

function add(a: Num, b: Num): Num {
    const [x, y] = align(a, b);
    return { n: x.n + y.n, s: x.s };
}

function sub(a: Num, b: Num): Num {
    const [x, y] = align(a, b);
    return { n: x.n - y.n, s: x.s };
}

function mul(a: Num, b: Num, scale: number): Num {
    const s = Math.min(a.s + b.s, Math.max(scale, a.s, b.s));
    return rescale({ n: a.n * b.n, s: a.s + b.s }, s);
}

function div(a: Num, b: Num, scale: number): Num {
    if (b.n === 0n) throw new BcError('Math error: divide by 0', 1);
    const numerator = a.n * pow10(b.s + scale);
    const denominator = b.n * pow10(a.s);
    return { n: numerator / denominator, s: scale };
}

function rem(a: Num, b: Num, scale: number): Num {
    return sub(a, mul(b, div(a, b, scale), scale));
}

function compare(a: Num, b: Num): number {
    const [x, y] = align(a, b);
    return x.n < y.n ? -1 : x.n > y.n ? 1 : 0;
}

function toInt(x: Num): bigint {
    return x.n / pow10(x.s);
}

function ipow(a: Num, e: bigint): Num {
    let n = 1n;
    for (let i = 0n; i < e; i++) n *= a.n;
    return { n, s: a.s * Number(e) };
}

function power(a: Num, e: Num, scale: number): Num {
    const exp = toInt(e);
    if (exp === 0n) return num(1n);
    if (exp > 100000n || exp < -100000n) throw new BcError('Math error: exponent out of range', 1);
    if (exp < 0n) {
        if (a.n === 0n) throw new BcError('Math error: divide by 0', 1);
        return div(num(1n), ipow(a, -exp), scale);
    }
    if (a.s * Number(exp) > 100000) throw new BcError('Math error: exponent out of range', 1);
    const s = Math.min(a.s * Number(exp), Math.max(scale, a.s));
    return rescale(ipow(a, exp), s);
}

function isqrt(v: bigint): bigint {
    if (v < 2n) return v;
    let x = v;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + v / x) / 2n;
    }
    return x;
}

function sqrtOf(x: Num, scale: number): Num {
    if (x.n < 0n) throw new BcError('Math error: negative number', 1);
    const s = Math.max(scale, x.s);
    return { n: isqrt(x.n * pow10(2 * s - x.s)), s };
}

/** How many digits after the point `1 / denom` needs in decimal, or 40 when it never terminates. */
function decimalScaleFor(denom: bigint): number {
    let value = denom;
    let twos = 0;
    let fives = 0;
    while (value % 2n === 0n) {
        value /= 2n;
        twos++;
    }
    while (value % 5n === 0n) {
        value /= 5n;
        fives++;
    }
    if (value !== 1n) return 40;
    return Math.max(twos, fives);
}

function parseNum(literal: string, ibase: number): Num {
    const dot = literal.indexOf('.');
    const ints = dot === -1 ? literal : literal.slice(0, dot);
    const fracs = dot === -1 ? '' : literal.slice(dot + 1);
    const digit = (ch: string): number => {
        const value = Number.parseInt(ch, 36);
        if (Number.isNaN(value) || value >= ibase) throw new BcError(`Runtime error: bad digit '${ch}' for ibase ${ibase}`, 3);
        return value;
    };
    let n = 0n;
    for (const ch of ints) n = n * BigInt(ibase) + BigInt(digit(ch));
    const base = BigInt(ibase);
    if (fracs === '') return { n, s: 0 };
    let f = 0n;
    for (const ch of fracs) f = f * base + BigInt(digit(ch));
    const denom = base ** BigInt(fracs.length);
    const m = decimalScaleFor(denom);
    return { n: n * pow10(m) + (f * pow10(m)) / denom, s: m };
}

const DIGIT_CHARS = '0123456789ABCDEF';

function toBaseDigits(value: bigint, base: number): number[] {
    if (value === 0n) return [0];
    const digits: number[] = [];
    let rest = value;
    while (rest > 0n) {
        digits.push(Number(rest % BigInt(base)));
        rest /= BigInt(base);
    }
    return digits.reverse();
}

/** The fraction digits of a number held as `frac / 10^s`, converted to `base`. */
function fractionDigits(frac: bigint, s: number, base: number): number[] {
    const scale = pow10(s);
    const digits: number[] = [];
    let rest = frac;
    for (let i = 0; i < s; i++) {
        rest *= BigInt(base);
        digits.push(Number(rest / scale));
        rest %= scale;
    }
    return digits;
}

function formatNum(x: Num, obase: number): string {
    if (x.n === 0n) return '0';
    const negative = x.n < 0n;
    const abs = negative ? -x.n : x.n;
    const int = abs / pow10(x.s);
    const frac = abs % pow10(x.s);
    const sign = negative ? '-' : '';
    if (obase === 10) {
        const intPart = x.s === 0 || int !== 0n ? int.toString() : '';
        const fracPart = x.s === 0 ? '' : frac.toString().padStart(x.s, '0');
        return sign + intPart + (fracPart === '' ? '' : '.' + fracPart);
    }
    const render = (digits: number[]): string =>
        obase <= 16
            ? digits.map((digit) => DIGIT_CHARS[digit] ?? '?').join('')
            : digits.map((digit) => ' ' + digit.toString()).join('');
    const intPart = x.s === 0 || int !== 0n ? render(toBaseDigits(int, obase)) : '';
    const fracPart = x.s === 0 ? '' : render(fractionDigits(frac, x.s, obase));
    return sign + intPart + (fracPart === '' ? '' : '.' + fracPart);
}

type BcTok =
    | { t: 'num'; v: string }
    | { t: 'str'; v: string }
    | { t: 'name'; v: string }
    | { t: 'op'; v: string }
    | { t: 'end' };

const BC_OPERATORS2 = ['+=', '-=', '*=', '/=', '%=', '^=', '==', '!=', '<=', '>=', '&&', '||'];

function tokenize(src: string): BcTok[] {
    const tokens: BcTok[] = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            i++;
            continue;
        }
        if (ch === '\n' || ch === ';') {
            tokens.push({ t: 'op', v: ';' });
            i++;
            continue;
        }
        if (ch === '#') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            let text = '';
            while (j < src.length && src[j] !== '"') {
                if (src[j] === '\\') {
                    const escape = src[j + 1];
                    text += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape ?? '';
                    j += 2;
                } else {
                    text += src[j];
                    j++;
                }
            }
            tokens.push({ t: 'str', v: text });
            i = j + 1;
            continue;
        }
        if (/[0-9A-F.]/.test(ch)) {
            let j = i;
            while (j < src.length && /[0-9A-Z.]/.test(src[j])) j++;
            tokens.push({ t: 'num', v: src.slice(i, j) });
            i = j;
            continue;
        }
        if (/[a-z_]/.test(ch)) {
            let j = i;
            while (j < src.length && /[a-z0-9_]/.test(src[j])) j++;
            tokens.push({ t: 'name', v: src.slice(i, j) });
            i = j;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (BC_OPERATORS2.includes(two)) {
            tokens.push({ t: 'op', v: two });
            i += 2;
            continue;
        }
        if ('+-*/%^=!(),[]{}<>'.includes(ch)) {
            tokens.push({ t: 'op', v: ch });
            i++;
            continue;
        }
        throw new BcError(`Parse error: illegal character '${ch}'`, 2);
    }
    tokens.push({ t: 'end' });
    return tokens;
}

type BcNode =
    | { k: 'num'; v: string }
    | { k: 'str'; v: string }
    | { k: 'var'; name: string }
    | { k: 'arr'; name: string; index: BcNode }
    | { k: 'bin'; op: string; a: BcNode; b: BcNode }
    | { k: 'neg'; a: BcNode }
    | { k: 'not'; a: BcNode }
    | { k: 'inc'; name: string; delta: number; prefix: boolean }
    | { k: 'and'; a: BcNode; b: BcNode }
    | { k: 'or'; a: BcNode; b: BcNode }
    | { k: 'assign'; op: string; name: string; index: BcNode | null; value: BcNode }
    | { k: 'call'; name: string; args: BcNode[] }
    | { k: 'if'; cond: BcNode; then: BcNode[]; otherwise: BcNode[] }
    | { k: 'while'; cond: BcNode; body: BcNode[] }
    | { k: 'for'; init: BcNode | null; cond: BcNode | null; step: BcNode | null; body: BcNode[] }
    | { k: 'return'; value: BcNode | null }
    | { k: 'break' }
    | { k: 'continue' }
    | { k: 'print'; args: BcNode[] }
    | { k: 'quit' }
    | { k: 'auto'; names: { name: string; array: boolean }[] }
    | { k: 'define'; name: string; params: { name: string; array: boolean }[]; body: BcNode[] }
    | { k: 'block'; body: BcNode[] };

const BC_PRECEDENCE: Record<string, number> = {
    '||': 2,
    '&&': 3,
    '==': 4,
    '!=': 4,
    '<': 4,
    '<=': 4,
    '>': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
    '^': 8
};

const BC_UNARY_PREC = 9;

class BcParser {
    private pos = 0;

    constructor(private readonly tokens: BcTok[]) {}

    private peek(): BcTok {
        return this.tokens[this.pos];
    }

    private next(): BcTok {
        return this.tokens[this.pos++];
    }

    private expectOp(op: string): void {
        const token = this.next();
        if (token.t !== 'op' || token.v !== op) throw new BcError(`Parse error: expected '${op}'`, 2);
    }

    private atOp(...ops: string[]): boolean {
        const token = this.peek();
        return token.t === 'op' && ops.includes(token.v);
    }

    parseProgram(): BcNode[] {
        const body: BcNode[] = [];
        while (this.peek().t !== 'end') {
            const statement = this.parseStatement();
            if (statement !== null) body.push(statement);
            if (this.atOp(';')) this.next();
        }
        return body;
    }

    private parseBlock(): BcNode[] {
        const body: BcNode[] = [];
        while (!this.atOp('}') && this.peek().t !== 'end') {
            const statement = this.parseStatement();
            if (statement !== null) body.push(statement);
            if (this.atOp(';')) this.next();
        }
        return body;
    }

    private parseStatement(): BcNode | null {
        const token = this.peek();
        if (token.t === 'op') {
            if (token.v === ';') return null;
            if (token.v === '{') {
                this.next();
                const body = this.parseBlock();
                this.expectOp('}');
                return { k: 'block', body };
            }
            return this.parseExpr(1);
        }
        if (token.t === 'name') {
            switch (token.v) {
                case 'define':
                    return this.parseDefine();
                case 'if': {
                    this.next();
                    this.expectOp('(');
                    const cond = this.parseExpr(1);
                    this.expectOp(')');
                    const then = this.parseStatementBody();
                    if (this.peek().t === 'name' && (this.peek() as { v: string }).v === 'else') {
                        this.next();
                        return { k: 'if', cond, then, otherwise: this.parseStatementBody() };
                    }
                    return { k: 'if', cond, then, otherwise: [] };
                }
                case 'while': {
                    this.next();
                    this.expectOp('(');
                    const cond = this.parseExpr(1);
                    this.expectOp(')');
                    return { k: 'while', cond, body: this.parseStatementBody() };
                }
                case 'for': {
                    this.next();
                    this.expectOp('(');
                    const init = this.atOp(';') ? null : this.parseExpr(1);
                    this.expectOp(';');
                    const cond = this.atOp(';') ? null : this.parseExpr(1);
                    this.expectOp(';');
                    const step = this.atOp(')') ? null : this.parseExpr(1);
                    this.expectOp(')');
                    return { k: 'for', init, cond, step, body: this.parseStatementBody() };
                }
                case 'return': {
                    this.next();
                    if (this.atOp(';', '}', ')') || this.peek().t === 'end') return { k: 'return', value: null };
                    return { k: 'return', value: this.parseExpr(1) };
                }
                case 'break':
                    this.next();
                    return { k: 'break' };
                case 'continue':
                    this.next();
                    return { k: 'continue' };
                case 'quit':
                case 'halt':
                    this.next();
                    return { k: 'quit' };
                case 'print': {
                    this.next();
                    const args = [this.parseExpr(1)];
                    while (this.atOp(',')) {
                        this.next();
                        args.push(this.parseExpr(1));
                    }
                    return { k: 'print', args };
                }
                case 'auto': {
                    this.next();
                    const names: { name: string; array: boolean }[] = [];
                    for (;;) {
                        const item = this.next();
                        if (item.t !== 'name') throw new BcError('Parse error: expected a name in auto', 2);
                        const array = this.atOp('[');
                        if (array) {
                            this.next();
                            this.expectOp(']');
                        }
                        names.push({ name: item.v, array });
                        if (!this.atOp(',')) break;
                        this.next();
                    }
                    return { k: 'auto', names };
                }
                default:
                    break;
            }
        }
        return this.parseExpr(1);
    }

    private parseStatementBody(): BcNode[] {
        const statement = this.parseStatement();
        if (statement === null) return [];
        if (statement.k === 'block') return statement.body;
        return [statement];
    }

    private parseDefine(): BcNode {
        this.next();
        const nameToken = this.next();
        if (nameToken.t !== 'name') throw new BcError('Parse error: expected a function name', 2);
        const params: { name: string; array: boolean }[] = [];
        this.expectOp('(');
        if (!this.atOp(')')) {
            for (;;) {
                const item = this.next();
                if (item.t !== 'name') throw new BcError('Parse error: expected a parameter name', 2);
                const array = this.atOp('[');
                if (array) {
                    this.next();
                    this.expectOp(']');
                }
                params.push({ name: item.v, array });
                if (!this.atOp(',')) break;
                this.next();
            }
        }
        this.expectOp(')');
        this.expectOp('{');
        const body = this.parseBlock();
        this.expectOp('}');
        return { k: 'define', name: nameToken.v, params, body };
    }

    private parseExpr(minPrec: number): BcNode {
        let left = this.parseUnary();
        for (;;) {
            const token = this.peek();
            if (token.t !== 'op') break;
            const prec = BC_PRECEDENCE[token.v];
            if (prec === undefined || prec < minPrec) break;
            this.next();
            const rightAssoc = token.v === '^';
            const rhs = this.parseExpr(rightAssoc ? prec : prec + 1);
            left =
                token.v === '&&'
                    ? { k: 'and', a: left, b: rhs }
                    : token.v === '||'
                      ? { k: 'or', a: left, b: rhs }
                      : { k: 'bin', op: token.v, a: left, b: rhs };
        }
        return left;
    }

    private parseUnary(): BcNode {
        const token = this.peek();
        const after = this.tokens[this.pos + 1];
        if (token.t === 'op' && after !== undefined && after.t === 'op' && token.v === after.v && (token.v === '+' || token.v === '-')) {
            this.next();
            this.next();
            const target = this.next();
            if (target.t !== 'name') throw new BcError('Parse error: ++ and -- need a variable', 2);
            return { k: 'inc', name: target.v, delta: token.v === '+' ? 1 : -1, prefix: true };
        }
        if (token.t === 'op' && token.v === '-') {
            this.next();
            return { k: 'neg', a: this.parseExpr(BC_UNARY_PREC) };
        }
        if (token.t === 'op' && token.v === '!') {
            this.next();
            return { k: 'not', a: this.parseExpr(BC_UNARY_PREC) };
        }
        return this.parsePostfix();
    }

    private parsePostfix(): BcNode {
        const token = this.next();
        if (token.t === 'num') return { k: 'num', v: token.v };
        if (token.t === 'str') return { k: 'str', v: token.v };
        if (token.t === 'op' && token.v === '(') {
            const value = this.parseExpr(1);
            this.expectOp(')');
            return value;
        }
        if (token.t !== 'name') throw new BcError('Parse error: expected a value', 2);
        if (this.atOp('(')) {
            this.next();
            const args: BcNode[] = [];
            if (!this.atOp(')')) {
                args.push(this.parseExpr(1));
                while (this.atOp(',')) {
                    this.next();
                    args.push(this.parseExpr(1));
                }
            }
            this.expectOp(')');
            return { k: 'call', name: token.v, args };
        }
        if (this.atOp('[')) {
            this.next();
            const index = this.parseExpr(1);
            this.expectOp(']');
            if (this.atOp('=') || this.atOp('+=', '-=', '*=', '/=', '%=', '^=')) {
                const opToken = this.next();
                const op = opToken.t === 'op' ? opToken.v : '=';
                return { k: 'assign', op, name: token.v, index, value: this.parseExpr(1) };
            }
            return { k: 'arr', name: token.v, index };
        }
        if (this.atOp('=') || this.atOp('+=', '-=', '*=', '/=', '%=', '^=')) {
            const opToken = this.next();
            const op = opToken.t === 'op' ? opToken.v : '=';
            return { k: 'assign', op, name: token.v, index: null, value: this.parseExpr(1) };
        }
        const next = this.peek();
        const after = this.tokens[this.pos + 1];
        if (next.t === 'op' && after !== undefined && after.t === 'op' && next.v === after.v && (next.v === '+' || next.v === '-')) {
            this.next();
            this.next();
            return { k: 'inc', name: token.v, delta: next.v === '+' ? 1 : -1, prefix: false };
        }
        return { k: 'var', name: token.v };
    }
}

interface BcFrame {
    vars: Map<string, Num>;
    arrs: Map<string, Map<string, Num>>;
}

interface BcFunc {
    params: { name: string; array: boolean }[];
    body: BcNode[];
}

interface BcMachine {
    scale: number;
    ibase: number;
    obase: number;
    frames: BcFrame[];
    funcs: Map<string, BcFunc>;
    out: string;
    mathlib: boolean;
}

function lookup(m: BcMachine, name: string): Num {
    for (let i = m.frames.length - 1; i >= 0; i--) {
        const found = m.frames[i].vars.get(name);
        if (found !== undefined) return found;
    }
    return ZERO;
}

function store(m: BcMachine, name: string, value: Num): void {
    for (let i = m.frames.length - 1; i >= 0; i--) {
        if (m.frames[i].vars.has(name)) {
            m.frames[i].vars.set(name, value);
            return;
        }
    }
    m.frames[m.frames.length - 1].vars.set(name, value);
}

function arrayOf(m: BcMachine, name: string): Map<string, Num> {
    for (let i = m.frames.length - 1; i >= 0; i--) {
        const found = m.frames[i].arrs.get(name);
        if (found !== undefined) return found;
    }
    const fresh = new Map<string, Num>();
    m.frames[m.frames.length - 1].arrs.set(name, fresh);
    return fresh;
}

function indexOf(m: BcMachine, node: BcNode): string {
    return formatNum(evalNode(m, node), 10);
}

function evalNode(m: BcMachine, node: BcNode): Num {
    switch (node.k) {
        case 'num':
            return parseNum(node.v, m.ibase);
        case 'str':
            throw new BcError('Runtime error: a string is not a number', 1);
        case 'var': {
            if (node.name === 'scale') return num(BigInt(m.scale));
            if (node.name === 'ibase') return num(BigInt(m.ibase));
            if (node.name === 'obase') return num(BigInt(m.obase));
            return lookup(m, node.name);
        }
        case 'arr':
            return arrayOf(m, node.name).get(indexOf(m, node.index)) ?? ZERO;
        case 'neg': {
            const a = evalNode(m, node.a);
            return { n: -a.n, s: a.s };
        }
        case 'inc': {
            const before = lookup(m, node.name);
            const after = add(before, num(BigInt(node.delta)));
            store(m, node.name, after);
            return node.prefix ? after : before;
        }
        case 'not':
            return evalNode(m, node.a).n === 0n ? num(1n) : ZERO;
        case 'and': {
            const a = evalNode(m, node.a);
            if (a.n === 0n) return ZERO;
            return evalNode(m, node.b).n === 0n ? ZERO : num(1n);
        }
        case 'or': {
            const a = evalNode(m, node.a);
            if (a.n !== 0n) return num(1n);
            return evalNode(m, node.b).n === 0n ? ZERO : num(1n);
        }
        case 'bin': {
            const a = evalNode(m, node.a);
            const b = evalNode(m, node.b);
            switch (node.op) {
                case '+':
                    return add(a, b);
                case '-':
                    return sub(a, b);
                case '*':
                    return mul(a, b, m.scale);
                case '/':
                    return div(a, b, m.scale);
                case '%':
                    return rem(a, b, m.scale);
                case '^':
                    return power(a, b, m.scale);
                default: {
                    const order = compare(a, b);
                    switch (node.op) {
                        case '==':
                            return order === 0 ? num(1n) : ZERO;
                        case '!=':
                            return order !== 0 ? num(1n) : ZERO;
                        case '<':
                            return order < 0 ? num(1n) : ZERO;
                        case '<=':
                            return order <= 0 ? num(1n) : ZERO;
                        case '>':
                            return order > 0 ? num(1n) : ZERO;
                        default:
                            return order >= 0 ? num(1n) : ZERO;
                    }
                }
            }
        }
        case 'assign': {
            const value = evalNode(m, node.value);
            if (node.name === 'scale') {
                m.scale = Math.max(0, Number(toInt(value)));
                return value;
            }
            if (node.name === 'ibase' || node.name === 'obase') {
                const wanted = Number(toInt(value));
                if (!Number.isFinite(wanted) || wanted < 2 || wanted > 36) {
                    throw new BcError(`Runtime error: bad ${node.name}: must be [2, 36]`, 3);
                }
                if (node.name === 'ibase') m.ibase = wanted;
                else m.obase = wanted;
                return value;
            }
            if (node.index !== null) {
                const array = arrayOf(m, node.name);
                const key = indexOf(m, node.index);
                const previous = array.get(key) ?? ZERO;
                array.set(key, combine(m, node.op, previous, value));
                return array.get(key) as Num;
            }
            const previous = lookup(m, node.name);
            store(m, node.name, combine(m, node.op, previous, value));
            return lookup(m, node.name);
        }
        case 'call':
            return callBc(m, node.name, node.args);
        case 'block':
            execBlock(m, node.body);
            return ZERO;
        case 'define':
            throw new BcError('Parse error: define is not an expression', 2);
        default:
            throw new BcError('Runtime error: an expression was expected', 1);
    }
}

function combine(m: BcMachine, op: string, previous: Num, value: Num): Num {
    switch (op) {
        case '+=':
            return add(previous, value);
        case '-=':
            return sub(previous, value);
        case '*=':
            return mul(previous, value, m.scale);
        case '/=':
            return div(previous, value, m.scale);
        case '%=':
            return rem(previous, value, m.scale);
        case '^=':
            return power(previous, value, m.scale);
        default:
            return value;
    }
}

function callBc(m: BcMachine, name: string, args: BcNode[]): Num {
    const single = (): Num => evalNode(m, args[0]);
    switch (name) {
        case 'sqrt':
            return sqrtOf(single(), m.scale);
        case 'length': {
            const x = single();
            const abs = x.n < 0n ? -x.n : x.n;
            const int = abs / pow10(x.s);
            const frac = x.s === 0 ? '' : (abs % pow10(x.s)).toString().padStart(x.s, '0');
            const digits = (int.toString() + frac).replace(/^0+/, '');
            return num(BigInt(Math.max(1, digits.length)));
        }
        case 'scale':
            return num(BigInt(single().s));
        case 'read':
            throw new BcError('Runtime error: read() is not supported on this runtime', 1);
        case 's':
        case 'c':
        case 'a':
        case 'l':
        case 'e':
        case 'j': {
            if (!m.mathlib) throw new BcError(`Runtime error: ${name}() needs the -l math library`, 1);
            if (name === 'j') throw new BcError('Runtime error: j(n,x) is not supported on this runtime', 1);
            const x = Number(formatNum(single(), 10));
            const value = name === 's' ? Math.sin(x) : name === 'c' ? Math.cos(x) : name === 'a' ? Math.atan(x) : name === 'l' ? Math.log(x) : Math.exp(x);
            if (!Number.isFinite(value)) throw new BcError('Math error: non-finite result', 1);
            return rescale(fromDouble(value), m.scale);
        }
        default:
            break;
    }
    const func = m.funcs.get(name);
    if (func === undefined) throw new BcError(`Runtime error: undefined function '${name}'`, 1);
    const frame: BcFrame = { vars: new Map(), arrs: new Map() };
    for (let i = 0; i < func.params.length; i++) {
        const param = func.params[i];
        const arg = args[i];
        if (arg === undefined) {
            if (param.array) frame.arrs.set(param.name, new Map());
            else frame.vars.set(param.name, ZERO);
            continue;
        }
        if (param.array) {
            if (arg.k === 'var' || arg.k === 'arr') frame.arrs.set(param.name, arrayOf(m, arg.name));
            else frame.arrs.set(param.name, new Map());
        } else {
            frame.vars.set(param.name, evalNode(m, arg));
        }
    }
    m.frames.push(frame);
    try {
        execBlock(m, func.body);
        return ZERO;
    } catch (error) {
        if (error instanceof BcSignal && error.kind === 'return') return error.value ?? ZERO;
        throw error;
    } finally {
        m.frames.pop();
    }
}

/** A double as a number with `scale` digits after the point; doubles carry about 15 good digits. */
function fromDouble(value: number): Num {
    const text = Math.abs(value).toFixed(20);
    const dot = text.indexOf('.');
    const ints = dot === -1 ? text : text.slice(0, dot);
    const fracs = dot === -1 ? '' : text.slice(dot + 1);
    const n = BigInt(ints + fracs) * (value < 0 ? -1n : 1n);
    return { n, s: fracs.length };
}

function execBlock(m: BcMachine, body: BcNode[]): void {
    for (const node of body) execNode(m, node);
}

function execNode(m: BcMachine, node: BcNode): void {
    switch (node.k) {
        case 'if': {
            if (evalNode(m, node.cond).n !== 0n) execBlock(m, node.then);
            else execBlock(m, node.otherwise);
            return;
        }
        case 'while': {
            while (evalNode(m, node.cond).n !== 0n) execBlock(m, node.body);
            return;
        }
        case 'for': {
            if (node.init !== null) evalNode(m, node.init);
            while (node.cond === null || evalNode(m, node.cond).n !== 0n) {
                execBlock(m, node.body);
                if (node.step !== null) evalNode(m, node.step);
            }
            return;
        }
        case 'return':
            throw new BcSignal('return', node.value === null ? null : evalNode(m, node.value));
        case 'break':
            throw new BcSignal('break', null);
        case 'continue':
            throw new BcSignal('continue', null);
        case 'quit':
            throw new BcSignal('quit', null);
        case 'auto': {
            const frame = m.frames[m.frames.length - 1];
            for (const item of node.names) {
                if (item.array) frame.arrs.set(item.name, new Map());
                else frame.vars.set(item.name, ZERO);
            }
            return;
        }
        case 'print': {
            for (const arg of node.args) {
                if (arg.k === 'str') m.out += arg.v;
                else m.out += formatNum(evalNode(m, arg), m.obase);
            }
            return;
        }
        case 'block':
            execBlock(m, node.body);
            return;
        case 'assign':
            evalNode(m, node);
            return;
        case 'define':
            m.funcs.set(node.name, { params: node.params, body: node.body });
            return;
        default: {
            const value = evalNode(m, node);
            m.out += formatNum(value, m.obase) + '\n';
            return;
        }
    }
}

function cmdBc(ctx: CommandContext): CommandResult {
    const files: string[] = [];
    let mathlib = false;
    for (const arg of ctx.args) {
        if (arg === '-l' || arg === '--mathlib') mathlib = true;
        else if (arg.startsWith('-') && arg !== '-') return fail(`bc: invalid option -- '${arg}'`);
        else files.push(arg);
    }
    let source: string;
    try {
        source = readInputs(ctx, files)
            .map((entry) => entry.text)
            .join('\n');
    } catch (error) {
        return fail(`bc: ${message(error)}`);
    }
    const m: BcMachine = {
        scale: mathlib ? 20 : 0,
        ibase: 10,
        obase: 10,
        frames: [{ vars: new Map(), arrs: new Map() }],
        funcs: new Map(),
        out: '',
        mathlib
    };
    try {
        const nodes = new BcParser(tokenize(source)).parseProgram();
        execBlock(m, nodes);
    } catch (error) {
        if (error instanceof BcSignal && error.kind === 'quit') return ok(m.out);
        if (error instanceof BcError) return { stdout: m.out, stderr: error.message + '\n', exitCode: error.code };
        return { stdout: m.out, stderr: `bc: ${message(error)}\n`, exitCode: 1 };
    }
    return ok(m.out);
}

/* ================================================================== *
 * 3. openssl
 * ================================================================== */

type HashFn = typeof sha256;

interface Digest {
    fn: HashFn;
    name: string;
}

const DIGESTS: Record<string, Digest> = {
    md5: { fn: md5 as unknown as HashFn, name: 'MD5' },
    sha1: { fn: sha1 as unknown as HashFn, name: 'SHA1' },
    sha224: { fn: sha224 as unknown as HashFn, name: 'SHA2-224' },
    sha256: { fn: sha256, name: 'SHA2-256' },
    sha384: { fn: sha384 as unknown as HashFn, name: 'SHA2-384' },
    sha512: { fn: sha512 as unknown as HashFn, name: 'SHA2-512' }
};

const OPENSSL_VERSION = 'OWC openssl 1.0.0 (subset: dgst md5 sha1 sha224 sha256 sha384 sha512 rand; digests by @noble/hashes)';

function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

function toBase64(bytes: Uint8Array): string {
    let text = '';
    for (let i = 0; i < bytes.length; i += 4096) {
        text += String.fromCharCode(...bytes.subarray(i, i + 4096));
    }
    return btoa(text);
}

function randomBytes(count: number): Uint8Array {
    const source = globalThis.crypto;
    if (source === undefined || typeof source.getRandomValues !== 'function') {
        throw new Error('rand: not supported on this runtime: there is no random source');
    }
    return source.getRandomValues(new Uint8Array(count));
}

interface DigestOptions {
    algorithm: string;
    /** What the digest is called on the report line; the bare `dgst` command says SHA256, as OpenSSL 3 does. */
    label: string | undefined;
    hmacKey: string | undefined;
    reverse: boolean;
    out: string | undefined;
    files: string[];
}

function runDigest(ctx: CommandContext, options: DigestOptions): CommandResult {
    const digest = DIGESTS[options.algorithm];
    let inputs: { name: string; text: string }[];
    try {
        inputs = readInputs(ctx, options.files);
    } catch (error) {
        return fail(message(error));
    }
    const encoder = new TextEncoder();
    let out = '';
    for (const input of inputs) {
        const data = encoder.encode(input.text);
        const bytes =
            options.hmacKey === undefined
                ? digest.fn(data)
                : hmac(digest.fn, encoder.encode(options.hmacKey), data);
        const hex = toHex(bytes);
        const label = input.name === '-' ? 'stdin' : input.name;
        const prefix = options.hmacKey === undefined ? (options.label ?? digest.name) : `HMAC-${options.label ?? digest.name}`;
        out += options.reverse ? `${hex} *${label}\n` : `${prefix}(${label})= ${hex}\n`;
    }
    if (options.out !== undefined) {
        try {
            ctx.fs.writeFile(at(ctx, options.out), out);
        } catch (error) {
            return fail(`openssl: ${options.out}: ${message(error)}`);
        }
        return ok();
    }
    return ok(out);
}

/** Reads `openssl dgst`'s words: one algorithm, then -hmac, -r, -out and the files. */
function parseDigestArgs(args: string[], fallback: string | undefined, label: string | undefined): DigestOptions | CommandResult {
    const options: DigestOptions = { algorithm: fallback ?? 'sha256', label, hmacKey: undefined, reverse: false, out: undefined, files: [] };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('-') && arg !== '-' && DIGESTS[arg.slice(1)] !== undefined) {
            options.algorithm = arg.slice(1);
            options.label = undefined;
            continue;
        }
        if (arg === '-hmac' || arg === '-mac') {
            options.hmacKey = args[++i] ?? '';
            continue;
        }
        if (arg === '-r') {
            options.reverse = true;
            continue;
        }
        if (arg === '-binary') {
            return fail(`openssl: -binary is not supported: this openssl writes text`);
        }
        if (arg === '-out') {
            options.out = args[++i];
            continue;
        }
        if (arg === '-hex' || arg === '-c' || arg === '-d') continue;
        if (arg.startsWith('-') && arg !== '-') {
            const name = arg.slice(1);
            if (DIGESTS[name] === undefined) return fail(`openssl: ${name}: unsupported digest`);
            options.algorithm = name;
            options.label = undefined;
            continue;
        }
        options.files.push(arg);
    }
    return options;
}

function cmdOpenssl(ctx: CommandContext): CommandResult {
    const [command, ...rest] = ctx.args;
    if (command === undefined) {
        return fail(`openssl: no command given; this openssl covers: dgst md5 sha1 sha224 sha256 sha384 sha512 rand version`);
    }
    switch (command) {
        case 'dgst': {
            const parsed = parseDigestArgs(rest, undefined, 'SHA256');
            if (!('files' in parsed)) return parsed;
            return runDigest(ctx, parsed);
        }
        case 'rand': {
            let hex = false;
            let base64 = false;
            let count: number | undefined;
            for (const arg of rest) {
                if (arg === '-hex') hex = true;
                else if (arg === '-base64') base64 = true;
                else if (/^\d+$/.test(arg)) count = Number(arg);
                else return fail(`openssl: rand: ${arg}: not supported`);
            }
            if (count === undefined) return fail(`openssl: rand: a byte count is required`);
            if (!hex && !base64) hex = true;
            let bytes: Uint8Array;
            try {
                bytes = randomBytes(count);
            } catch (error) {
                return fail(`openssl: ${message(error)}`);
            }
            return ok((base64 ? toBase64(bytes) : toHex(bytes)) + '\n');
        }
        case 'version':
            return ok(OPENSSL_VERSION + '\n');
        case 'help':
            return ok(`openssl: this openssl covers: dgst md5 sha1 sha224 sha256 sha384 sha512 rand version\n`);
        default: {
            if (DIGESTS[command] !== undefined) {
                const parsed = parseDigestArgs(rest, command, undefined);
                if (!('files' in parsed)) return parsed;
                return runDigest(ctx, parsed);
            }
            return fail(`Invalid command '${command}'; type "help" for a list.`);
        }
    }
}

/* ================================================================== *
 * 4. The utilities the container cannot have
 * ================================================================== */

/**
 * Every name here gets one line naming what the container lacks and exit status 1: never 127
 * 'Command not found', never a crash, and never a success that did not happen.
 *
 * The line carries a code after the name, so a caller that greps the message for a reason and a
 * caller that matches on a code both get one: `[ERR_NO_RAW_SOCKET]` and the words after it say the
 * same thing, and the code is stable while the wording is not. The codes are named the way the
 * rest of this file names a failure (`ETIMEDOUT`, `ENOTFOUND`, `ERR_INVALID_URL`): a name a reader
 * can search for, not a number to look up.
 *
 * The message goes to stderr, and that is the whole of the decision behind it. It is a diagnostic:
 * the command produced no output, so stdout stays empty and `cmd > file`, `cmd | grep` and
 * `$(cmd)` all see nothing rather than a sentence. The playground terminal is one xterm that prints
 * both streams of the shell it runs, so the reason reaches the reader either way.
 */
export interface Unsupported {
    /** The named code the report carries. */
    code: string;
    /** Why the container cannot have this utility, in one line that names the missing capability. */
    reason: string;
}

export const UNSUPPORTED: Record<string, Unsupported> = {
    /* network: no raw sockets, no interfaces */
    ping: { code: 'ERR_NO_RAW_SOCKET', reason: 'the container has no raw sockets, so it cannot send ICMP echo requests' },
    dig: { code: 'ERR_NO_DNS_RESOLVER', reason: 'the container has no DNS resolver and no UDP sockets, so it cannot send a query' },
    traceroute: { code: 'ERR_NO_RAW_SOCKET', reason: 'the container has no raw sockets, so it cannot send or receive ICMP' },
    nc: { code: 'ERR_NO_SOCKET_API', reason: 'the container has no TCP or UDP sockets, so it cannot connect or listen' },
    netstat: { code: 'ERR_NO_SOCKET_TABLE', reason: 'the container has no socket table to report' },
    ss: { code: 'ERR_NO_SOCKET_TABLE', reason: 'the container has no socket table to report' },
    ip: { code: 'ERR_NO_NETWORK_INTERFACES', reason: 'the container has no network interfaces to configure: its virtual network is one loopback range with no interface of its own' },
    nft: { code: 'ERR_NO_PACKET_FILTER', reason: 'the container has no kernel packet filter to program' },

    /* privileged: no host OS */
    systemctl: { code: 'ERR_NO_INIT_SYSTEM', reason: 'there is no init system: the container is one JavaScript process, not an OS' },
    cron: { code: 'ERR_NO_DAEMON', reason: 'there is no cron daemon: nothing runs while the shell is not running' },
    crontab: { code: 'ERR_NO_CRON_DAEMON', reason: 'there is no cron daemon to install a table into' },
    chroot: { code: 'ERR_NO_HOST_OS', reason: 'there is no host OS: the container cannot change its own root' },
    su: { code: 'ERR_NO_USER_DATABASE', reason: 'the container is single-user and has no user database to switch with' },
    sudo: { code: 'ERR_NO_PRIVILEGE', reason: 'the container is single-user and has no privilege to raise' },
    usermod: { code: 'ERR_NO_USER_DATABASE', reason: 'the container has no user database to modify' },
    groupadd: { code: 'ERR_NO_GROUP_DATABASE', reason: 'the container has no group database to modify' },
    groupdel: { code: 'ERR_NO_GROUP_DATABASE', reason: 'the container has no group database to modify' },

    /* packaging: no dpkg */
    dh: { code: 'ERR_NO_DEBHELPER', reason: 'the container ships no debhelper: there is no dpkg to build a Debian package with' },

    /* hardware: nothing to measure */
    lspci: { code: 'ERR_NO_PCI_BUS', reason: 'the container has no PCI bus to enumerate' },
    iostat: { code: 'ERR_NO_BLOCK_DEVICES', reason: 'the container has no block devices to report I/O for' },
    vmstat: { code: 'ERR_NO_KERNEL_COUNTERS', reason: 'the container has no kernel memory or CPU counters to report' },
    perf: { code: 'ERR_NO_PERF_COUNTERS', reason: 'the container has no hardware performance counters to read' },

    /* nothing to enumerate: no open-file table, no removable media */
    lsof: { code: 'ERR_NO_OPEN_FILE_TABLE', reason: 'the container keeps no table of open files: the file system is written through, never held open by a process' },
    eject: { code: 'ERR_NO_REMOVABLE_MEDIA', reason: 'the container has no removable media and no drive to eject one from' },

    /* interactive, or a foreign desktop */
    tmux: { code: 'ERR_NO_TERMINAL', reason: 'the container has no terminal to multiplex: the shell runs one line at a time' },
    vi: { code: 'ERR_NO_INTERACTIVE_EDITOR', reason: 'the container has no interactive editor: there is no terminal and input arrives a line at a time' },
    import: { code: 'ERR_NO_X_DISPLAY', reason: 'the container has no X display to capture' },
    xclip: { code: 'ERR_NO_X_SELECTION', reason: 'the container has no X selection to read or write' },
    open: { code: 'ERR_NO_DESKTOP', reason: 'the container cannot open a file on the host desktop' },
    write: { code: 'ERR_NO_OTHER_USERS', reason: 'the container has no other users and no terminals to write to' }
};

/** True when `name` is a utility the container cannot have. */
export function isUnsupported(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(UNSUPPORTED, name);
}

/** The line an unsupported utility reports, and the status it reports with (1). */
export function unsupportedResult(name: string): CommandResult {
    const entry = UNSUPPORTED[name];
    if (entry === undefined) return fail(`${name}: Command not found`, 127);
    return fail(`${name}: [${entry.code}] not supported on this runtime: ${entry.reason}`);
}

/** The same outcome as a handler, so a dispatcher can merge it into its table in one line. */
export const UNSUPPORTED_COMMANDS: Record<string, ShellCommand> = Object.fromEntries(
    Object.keys(UNSUPPORTED).map((name) => [name, () => unsupportedResult(name)])
);

/* ================================================================== *
 * 5. curl and wget: a real request, through the host's fetch
 * ================================================================== */

/**
 * The one outbound HTTP path the container has, and the one `curl` and `wget` use: the host's
 * `fetch`, the same call the guest's `http.fetch` capability makes in
 * process/executors/node/runtime/capabilities/http.ts. There is no socket to open and no resolver to
 * query, so what the browser refuses -- an origin that sends no CORS header, a certificate it will
 * not accept, a name that does not resolve -- arrives as one TypeError and is reported as exactly
 * that, never dressed up as a response.
 *
 * A request is asynchronous, so neither utility is in `COMMANDS`: a handler there is synchronous
 * (shell/commands/types.ts) and cannot wait for one. They are exported for the dispatcher that can
 * wait -- the shell's external-command registry -- and both answer with the same `CommandResult`.
 */

/** The version `curl --version` and `wget --version` report: the one in packages/core/package.json. */
const NET_VERSION = '0.1.0';

/** Upper bound for one request, from start to the last body byte: the `http.fetch` capability's. */
const NET_TIMEOUT_MS = 30000;

/** Headers a browser fetch refuses, or that describe the transport rather than the message. */
const NET_TRANSPORT_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'expect']);

/** A failure with a name. The code is what the utility's exit status is chosen from. */
function netFailure(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

/** A command line this utility refuses to act on, as opposed to a request that failed. */
function usageFailure(message: string): Error {
    return netFailure('ERR_USAGE', message);
}

/** The named code an error carries, or ERR_UNKNOWN when it carries none. */
function netCode(error: unknown): string {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' ? code : 'ERR_UNKNOWN';
}

/** The one request. */
interface NetRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

/** The one response: its status, its headers and its body as the bytes that arrived. */
interface NetResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bytes: Uint8Array;
    url: string;
}

/** The URL as a request will use it: a bare host gets the `http://` both utilities default to. */
function netAbsolute(url: string): string {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
}

/**
 * One request, run by the host's fetch with the rules the `http.fetch` capability uses: a transport
 * header is dropped rather than sent, redirects are followed, and the whole thing is abandoned after
 * NET_TIMEOUT_MS. It either returns a response or throws with a name; it never returns a response it
 * did not receive.
 */
async function netFetch(request: NetRequest): Promise<NetResponse> {
    if (typeof fetch !== 'function') {
        throw netFailure('ERR_NO_FETCH', 'no fetch is available, so the container cannot make an outbound request');
    }
    const absolute = netAbsolute(request.url);
    let target: URL;
    try {
        target = new URL(absolute);
    } catch {
        throw netFailure('ERR_INVALID_URL', `Invalid URL: ${request.url}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw netFailure('ERR_INVALID_PROTOCOL', `Protocol "${target.protocol}" not supported. Expected "http:" or "https:"`);
    }
    const method = request.method.toUpperCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (NET_TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
        try {
            headers.append(name, value);
        } catch {
            // a value the browser refuses is dropped, the way fetch drops it
        }
    }
    const body = request.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : request.body;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
    try {
        const response = await fetch(target.href, { method, headers, body, redirect: 'follow', signal: controller.signal });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const received: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            if (name !== 'set-cookie') received[name] = value;
        });
        return { status: response.status, statusText: response.statusText, headers: received, bytes, url: response.url };
    } catch (error) {
        if (controller.signal.aborted) {
            throw netFailure('ETIMEDOUT', `request to ${target.href} timed out after ${NET_TIMEOUT_MS} ms`);
        }
        if (error instanceof TypeError) {
            // the browser reports name resolution, TLS and CORS failures the same way
            throw netFailure('ENOTFOUND', `getaddrinfo ENOTFOUND ${target.hostname}: the browser could not complete the request (name resolution, TLS or CORS)`);
        }
        throw netFailure('ECONNRESET', error instanceof Error ? error.message : String(error));
    } finally {
        clearTimeout(timer);
    }
}

/** The status `curl` reports for a named failure: its own, where it has one. */
function curlStatus(code: string): number {
    switch (code) {
        case 'ERR_INVALID_URL': return 3;
        case 'ETIMEDOUT': return 28;
        case 'ENOTFOUND': return 6;
        case 'ECONNRESET': return 56;
        default: return 1;
    }
}

/** The status `wget` reports for a named failure. */
function wgetStatus(code: string): number {
    switch (code) {
        case 'ETIMEDOUT': return 4;
        case 'ENOTFOUND': return 4;
        case 'ECONNRESET': return 4;
        default: return 1;
    }
}

/** The response head as it goes to stdout for `-i` and `-I`. */
function netHead(response: NetResponse): string {
    let out = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
    for (const [name, value] of Object.entries(response.headers)) out += `${name}: ${value}\r\n`;
    return out + '\r\n';
}

/** True when `headers` already carries `name`, whatever case it was written in. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
    return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** The file, and the bytes written to it: what a shell command needs of the container to save a body. */
export interface NetWriter {
    /** A path argument, resolved against the directory the command runs in. */
    resolve(path: string): string;
    /** The bytes of a response, written to a file as bytes. */
    writeBytes(path: string, bytes: Uint8Array): void;
}

/* ---- curl ---- */

interface CurlSpec {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** `-o`: the file the body is written to, or `-` for stdout. Undefined when stdout is the target. */
    output?: string;
    head: boolean;
    include: boolean;
}

/** The curl options that take the next word as their argument. */
const CURL_VALUED = new Set(['-o', '-X', '-H', '-d']);

/** The wget options that take the next word as their argument. */
const WGET_VALUED = new Set(['-O']);

/** One option and the text that followed it inside the same word, if any did. */
interface NetOption {
    option: string;
    /** The rest of the word, when the option was written with its argument attached. */
    inline?: string;
}

/**
 * The options one word carries, the way both utilities read them: `-sS` is `-s` and `-S`, `-oFILE`
 * is `-o` with FILE, `--output=FILE` is `--output` with FILE, and a cluster ends where the first
 * option that takes an argument begins. A word that is not an option at all comes back whole, so
 * the caller decides it is a URL.
 */
function netOptions(word: string, valued: Set<string>): NetOption[] {
    if (word === '-' || !word.startsWith('-')) return [{ option: word }];
    if (word.startsWith('--')) {
        const equals = word.indexOf('=');
        return equals > 0 ? [{ option: word.slice(0, equals), inline: word.slice(equals + 1) }] : [{ option: word }];
    }
    if (!/^-[a-zA-Z]+$/.test(word)) return [{ option: word }];
    const letters = word.slice(1);
    const out: NetOption[] = [];
    for (let i = 0; i < letters.length; i++) {
        const option = `-${letters[i]}`;
        out.push({ option, inline: letters.slice(i + 1) });
        if (valued.has(option)) break;
    }
    return out;
}

/**
 * The curl options this container's curl has, and nothing else: an option it does not implement is
 * refused with a name rather than read and ignored, because a request made with a flag that was
 * silently dropped is a request the caller did not ask for.
 */
function parseCurlArgs(args: string[]): CurlSpec {
    const spec: CurlSpec = { url: '', method: '', headers: {}, head: false, include: false };
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        const apply = (option: string, inline?: string): void => {
            const value = (): string => {
                if (inline !== undefined && inline !== '') return inline;
                const next = args[index + 1];
                if (next === undefined) throw usageFailure(`option ${option} requires an argument`);
                index += 1;
                return next;
            };
            switch (option) {
                // no progress meter is ever written, so -s has nothing to silence, and errors always go
                // to stderr, so -S has nothing to enable: both are accepted and neither changes anything.
                case '-s': case '--silent': case '-S': case '--show-error': break;
                case '-o': case '--output': spec.output = value(); break;
                case '-X': case '--request': spec.method = value(); break;
                case '-H': case '--header': {
                    const header = value();
                    const colon = header.indexOf(':');
                    if (colon <= 0) throw usageFailure(`header "${header}" has no name before its colon`);
                    spec.headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
                    break;
                }
                case '-d': case '--data': case '--data-raw': case '--data-ascii': {
                    const data = value();
                    spec.body = spec.body === undefined ? data : `${spec.body}&${data}`;
                    break;
                }
                case '-I': case '--head': spec.head = true; break;
                case '-i': case '--include': spec.include = true; break;
                default: throw usageFailure(`option ${option} is not supported on this runtime`);
            }
        };
        if (arg.startsWith('-')) {
            for (const { option, inline } of netOptions(arg, CURL_VALUED)) apply(option, inline);
        } else {
            if (spec.url !== '') throw usageFailure('only one URL per invocation is supported');
            spec.url = arg;
        }
        index += 1;
    }
    if (spec.url === '') throw usageFailure('no URL specified');
    if (spec.method === '') spec.method = spec.head ? 'HEAD' : spec.body === undefined ? 'GET' : 'POST';
    if (spec.body !== undefined && !hasHeader(spec.headers, 'content-type')) {
        spec.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return spec;
}

/**
 * `curl` at the point where it has not reached the network yet, and a caller that cannot reach it.
 *
 * Two invocations need no request: `--version`, which names no URL, and one the argument parser
 * refuses -- no URL at all, an unsupported option, a header with no name -- which is a usage failure
 * with `curl`'s own status 2. Both are answered here, in the container's own words. An invocation
 * that does name a URL returns null: that is a request, and only the asynchronous `curl` can make
 * one, because a synchronous child has no way to wait for host work.
 */
export function curlUsageResult(args: string[]): CommandResult | null {
    if (args.length > 0 && args.every((arg) => arg === '--version' || arg === '-V')) {
        return ok(`curl ${NET_VERSION} (OpenWebContainer)\nProtocols: http https\nFeatures: fetch\n`);
    }
    try {
        parseCurlArgs(args);
    } catch (error) {
        return fail(`curl: ${message(error)}`, netCode(error) === 'ERR_USAGE' ? 2 : 1);
    }
    return null;
}

/**
 * `curl`: one request, its body to stdout or to `-o`. A response that arrived is never reported as a
 * failure, and a request that did not is never reported as a success: every non-zero status here is
 * either a named failure of the request or an HTTP status of 400 and above.
 */
export async function curlCommand(args: string[], io: NetWriter): Promise<CommandResult> {
    const withoutNetwork = curlUsageResult(args);
    if (withoutNetwork !== null) return withoutNetwork;
    const spec = parseCurlArgs(args);
    let response: NetResponse;
    try {
        response = await netFetch({ url: spec.url, method: spec.method, headers: spec.headers, body: spec.body });
    } catch (error) {
        const status = curlStatus(netCode(error));
        return fail(`curl: (${status}) ${message(error)}`, status);
    }
    const body = new TextDecoder().decode(response.bytes);
    const stdout = (spec.include || spec.head ? netHead(response) : '') + (spec.head ? '' : body);
    if (response.status >= 400) {
        const reason = `curl: (22) The requested URL returned error: ${response.status} ${response.statusText}`;
        if (spec.output !== undefined && spec.output !== '-') return fail(reason, 22);
        return { stdout, stderr: `${reason}\n`, exitCode: 22 };
    }
    if (spec.output !== undefined && spec.output !== '-') {
        try {
            io.writeBytes(io.resolve(spec.output), response.bytes);
        } catch (error) {
            return fail(`curl: (23) ${message(error)}`, 23);
        }
        return ok();
    }
    return { stdout, stderr: '', exitCode: 0 };
}

/* ---- wget ---- */

interface WgetSpec {
    url: string;
    /** `-O`: the file the body is written to, or `-` for stdout. Undefined means the URL's own name. */
    output?: string;
    quiet: boolean;
}

function parseWgetArgs(args: string[]): WgetSpec {
    const spec: WgetSpec = { url: '', quiet: false };
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        const apply = (option: string, inline?: string): void => {
            const value = (): string => {
                if (inline !== undefined && inline !== '') return inline;
                const next = args[index + 1];
                if (next === undefined) throw usageFailure(`option ${option} requires an argument`);
                index += 1;
                return next;
            };
            switch (option) {
                case '-q': case '--quiet': spec.quiet = true; break;
                case '-O': case '--output-document': spec.output = value(); break;
                default: throw usageFailure(`option ${option} is not supported on this runtime`);
            }
        };
        if (arg.startsWith('-')) {
            for (const { option, inline } of netOptions(arg, WGET_VALUED)) apply(option, inline);
        } else {
            if (spec.url !== '') throw usageFailure('only one URL per invocation is supported');
            spec.url = arg;
        }
        index += 1;
    }
    if (spec.url === '') throw usageFailure('no URL specified');
    return spec;
}

/** The file `wget URL` saves to when no `-O` names one: the last segment of the path, index.html if none. */
function wgetName(url: string): string {
    let pathname: string;
    try {
        pathname = new URL(netAbsolute(url)).pathname;
    } catch {
        pathname = url;
    }
    const trimmed = pathname.replace(/\/+$/, '');
    const last = trimmed.split('/').pop() ?? '';
    return last === '' ? 'index.html' : last;
}

/** `wget`: one GET, its body to `-O` or to the file the URL names. `-O -` writes to stdout. */
export async function wgetCommand(args: string[], io: NetWriter): Promise<CommandResult> {
    if (args.length > 0 && args.every((arg) => arg === '--version' || arg === '-V')) {
        return ok(`Wget ${NET_VERSION} (OpenWebContainer)\n`);
    }
    let spec: WgetSpec;
    try {
        spec = parseWgetArgs(args);
    } catch (error) {
        return fail(`wget: ${message(error)}`, netCode(error) === 'ERR_USAGE' ? 2 : 1);
    }
    let response: NetResponse;
    try {
        response = await netFetch({ url: spec.url, method: 'GET', headers: {} });
    } catch (error) {
        return fail(`wget: ${message(error)}`, wgetStatus(netCode(error)));
    }
    if (response.status >= 400) {
        return fail(`wget: server returned error: ${response.status} ${response.statusText}`, 8);
    }
    if (spec.output === '-') {
        return { stdout: new TextDecoder().decode(response.bytes), stderr: '', exitCode: 0 };
    }
    const path = io.resolve(spec.output ?? wgetName(spec.url));
    try {
        io.writeBytes(path, response.bytes);
    } catch (error) {
        return fail(`wget: ${message(error)}`, 3);
    }
    // nothing here invents a transfer rate or a time: the byte count is the one thing measured
    return { stdout: '', stderr: spec.quiet ? '' : `wget: saved ${response.bytes.length} bytes to ${path}\n`, exitCode: 0 };
}

/* ================================================================== *
 * 6. The table
 * ================================================================== */

export const COMMANDS: Record<string, ShellCommand> = {
    make: cmdMake,
    bc: cmdBc,
    openssl: cmdOpenssl
};
