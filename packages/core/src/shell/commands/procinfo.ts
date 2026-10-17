/**
 * Process and system reporting in the OWC guest shell.
 *
 *   ps  top  kill  killall  pkill  nice  nohup  time  watch
 *   hostname  who  whoami  users  groups  tty  sync
 *   locate  slocate  vdir  less  more  man  open  xclip
 *   clear  ifconfig
 *
 * Two things shape this file.
 *
 *  1. `CommandContext` carries no process table, so the seven commands that need one (`ps`, `top`,
 *     `kill`, `killall`, `pkill`, `watch`, `time`) read it through a `ProcessHost` installed once by
 *     the orchestrator with `setProcessHost`. `types.ts` is untouched. Everything else runs on the
 *     context alone.
 *
 *  2. The container has no terminals, no utmp, no X server and no desktop. The terminal-shaped
 *     utilities keep the host's option surface and exit codes and degrade in a documented way:
 *     `less`/`more` are pass-through pagers, `tty` reports "not a tty", `open` and `xclip` report the
 *     missing desktop/display. `man` has pages after all -- one per command this container
 *     implements, assembled from the usage line that command already prints -- and answers the
 *     host's own "No manual entry for <name>" for anything else. Each decision is recorded next to
 *     the command and in MANIFEST.md.
 *
 * Output shapes (column headers, field widths, sort order, exit codes, usage text) were measured
 * against the host utilities on macOS; the values printed are the container's own.
 */

import type { ShellCommand, CommandContext, CommandResult } from './types';
import { atPath, inputText } from './types';
import type { HubState } from '../../network/virtual/hub';
import { runWithRunner } from './builtins';
import { HELP, IMPLEMENTED_BUILTINS } from './builtins';
import { USAGE as TEXT_USAGE, COMMANDS as TEXT_UTILS } from './textutils';
import { USAGE as FILE_USAGE, COMMANDS as FILE_UTILS } from './fileutils';
import { createShellState, runScript } from './builtins';
import type { ShellFs } from './builtins';

/* ================================================================== *
 * 1. Process host
 * ================================================================== */

/** The slice of the container the shell needs that `CommandContext` does not carry. */
export interface ProcessHost {
    /** Every live process, in whatever order the host keeps them. */
    list(): { pid: number; ppid: number; command: string; state: string; cpuMs?: number }[];
    /** Delivers `name` (e.g. "TERM", "9", "KILL") to `pid`. False when there is no such process. */
    signal(pid: number, name: string): boolean;
    /** A millisecond clock. Only `time` and `watch` read it. */
    now(): number;
    /**
     * Optional. Runs one command line and returns its result; `nice`, `nohup`, `time` and `watch`
     * exist to run something, and the context alone cannot. This is the one addition to the
     * documented interface: it is optional, so an adapter written against `list`/`signal`/`now`
     * alone still type-checks. Without it those four report that they cannot run a command.
     */
    run?(words: string[], input: string | null): CommandResult;
}

let host: ProcessHost | null = null;

/** Installs the process host. Call once per container, before the shell runs a command. */
export function setProcessHost(next: ProcessHost): void {
    host = next;
}

function hostOr(): ProcessHost | null {
    return host;
}

function noHost(name: string): CommandResult {
    return fail(`${name}: no process host is installed (call setProcessHost)`, 1);
}

/**
 * Runs the utility one of the four wrappers was given, or null when nothing can run it.
 *
 * The process host is asked first. A host that only lists processes has no `run` (`container.ts`
 * installs none), so the wrapper falls back to the runner the shell installed through
 * `builtins.ts`: those four exist to run something, and reporting that they cannot is what made
 * `nice echo hi` print nothing and exit 127.
 */
function runCommand(ctx: CommandContext, words: string[]): CommandResult | null {
    const h = hostOr();
    if (h?.run) return h.run(words, ctx.input);
    return runWithRunner(ctx, words, ctx.input ?? null);
}

/* ================================================================== *
 * 2. Small helpers
 * ================================================================== */

/** The container's identity, as reported by `process.getuid`/`userInfo` inside it. */
const OWC_USER = 'user';
const OWC_UID = 1000;
const OWC_GID = 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function out(text: string): CommandResult {
    return { stdout: text === '' ? '' : text.endsWith('\n') ? text : text + '\n', stderr: '', exitCode: 0 };
}

function fail(message: string, exitCode: number): CommandResult {
    return { stdout: '', stderr: message.endsWith('\n') ? message : message + '\n', exitCode };
}

function pad(s: string, width: number): string {
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function padRight(s: string, width: number): string {
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padCenter(s: string, width: number): string {
    if (s.length >= width) return s;
    const left = Math.floor((width - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(width - s.length - left);
}

/** `M:SS.ss`, the host `ps`/`top` TIME shape (`0:00.01`, `633:01.85`). */
function clockTime(ms: number): string {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const minutes = Math.floor(safe / 60000);
    const seconds = (safe % 60000) / 1000;
    return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

/** `Mon DD HH:MM`, the utmp/`who` time shape (`Oct 15 15:35`). */
function utmpTime(ms: number): string {
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hostnameOf(ctx: CommandContext): string {
    return ctx.env.HOSTNAME || ctx.env.NAME || 'localhost';
}

/** Splits `hostOrNull` style option words: `-ef` -> `e`,`f`; `aux` -> `a`,`u`,`x`. */
function cluster(word: string): string[] {
    return word.replace(/^-/, '').split('');
}

/**
 * Reads a file the way a utility reads one: a missing path is `undefined`, not a throw. The
 * container's file system signals ENOENT by throwing, so every read goes through here.
 */
function tryRead(ctx: CommandContext, path: string): string | undefined {
    try {
        return ctx.fs.readFile(path);
    } catch {
        return undefined;
    }
}

/** Stat that cannot throw either. */
function tryStat(ctx: CommandContext, path: string) {
    try {
        return ctx.fs.statPath(path);
    } catch {
        return undefined;
    }
}

/** The container's process table carries no start time, so ps prints `??` where the host prints one. */
const PS_UNKNOWN_START = '??';

/* ================================================================== *
 * 3. Signals
 * ================================================================== */

/** The signal table of `kill -l` on the host: 31 names, printed 16 to a line. */
const SIGNAL_NAMES = [
    'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'EMT', 'FPE', 'KILL', 'BUS', 'SEGV', 'SYS',
    'PIPE', 'ALRM', 'TERM', 'URG', 'STOP', 'TSTP', 'CONT', 'CHLD', 'TTIN', 'TTOU', 'IO', 'XCPU',
    'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'INFO', 'USR1', 'USR2'
];

function signalList(lower: boolean, perLine = 16): string {
    const names = lower ? SIGNAL_NAMES.map((n) => n.toLowerCase()) : SIGNAL_NAMES;
    const lines: string[] = [];
    for (let i = 0; i < names.length; i += perLine) {
        lines.push(names.slice(i, i + perLine).join(' ') + (lower ? ' ' : ''));
    }
    return lines.join('\n');
}

/** Resolves a signal word (`9`, `KILL`, `SIGKILL`, `kill`) to a canonical name. Null when unknown. */
function resolveSignal(word: string): string | null {
    const bare = word.startsWith('-') ? word.slice(1) : word;
    const upper = bare.toUpperCase().replace(/^SIG/, '');
    if (/^\d+$/.test(upper)) {
        const n = Number(upper);
        // 0 is the "does it exist" signal: `killall -0` and `kill -0` use it.
        return n >= 0 && n <= SIGNAL_NAMES.length ? (n === 0 ? '0' : SIGNAL_NAMES[n - 1]) : null;
    }
    return SIGNAL_NAMES.indexOf(upper) === -1 ? null : SIGNAL_NAMES[SIGNAL_NAMES.indexOf(upper)];
}

/* ================================================================== *
 * 4. ps
 * ================================================================== */

interface Proc {
    pid: number;
    ppid: number;
    command: string;
    state: string;
    cpuMs: number;
}

const PS_USAGE = [
    'usage: ps [-AaCcEefhjlMmrSTvwXx] [-O fmt | -o fmt] [-G gid[,gid...]]',
    '          [-g grp[,grp...]] [-u [uid,uid...]]',
    '          [-p pid[,pid...]] [-t tty[,tty...]] [-U user[,user...]]',
    '       ps [-L]'
].join('\n');

const PS_STATE_LETTERS: Record<string, string> = {
    running: 'R', sleeping: 'S', waiting: 'S', blocked: 'S', idle: 'I', stopped: 'T',
    terminated: 'Z', zombie: 'Z', completed: 'Z', exited: 'Z', created: 'I', dead: 'Z'
};

function statLetter(state: string): string {
    const s = (state || '').toLowerCase();
    if (/^[rstzid]$/.test(s)) return s.toUpperCase();
    return PS_STATE_LETTERS[s] ?? '?';
}

function stateWord(state: string): string {
    const s = (state || '').toLowerCase();
    if (s === 'running') return 'running';
    if (s === 'stopped') return 'stopped';
    if (s === 'terminated' || s === 'zombie' || s === 'completed' || s === 'exited' || s === 'dead') return 'zombie';
    if (s === 'created' || s === 'idle') return 'idle';
    return 'sleeping';
}

/** The first word of a command line, basenamed: what a process name means here. */
function commOf(command: string): string {
    const first = (command || '').trim().split(/\s+/)[0] ?? '';
    const slash = first.lastIndexOf('/');
    return slash === -1 ? first : first.slice(slash + 1);
}

function procsOf(h: ProcessHost): Proc[] {
    return h
        .list()
        .map((p) => ({ pid: p.pid, ppid: p.ppid ?? 0, command: p.command ?? '', state: p.state ?? '', cpuMs: p.cpuMs ?? 0 }))
        .sort((a, b) => a.pid - b.pid);
}

interface PsOptions {
    all: boolean;
    long: boolean;
    full: boolean;
    jobs: boolean;
    userFormat: boolean;
    sortCpu: boolean;
    noHeader: boolean;
    pids: number[] | null;
    rawPids: string[] | null;
    users: string[] | null;
    ttys: string[] | null;
    format: string[] | null;
}

function parsePs(args: string[]): PsOptions | { usage: string } {
    const o: PsOptions = {
        all: false, long: false, full: false, jobs: false, userFormat: false,
        sortCpu: false, noHeader: false, pids: null, rawPids: null, users: null, ttys: null, format: null
    };
    let i = 0;
    let sawOption = false;
    while (i < args.length) {
        const arg = args[i];
        if (arg === '--') { i++; break; }
        // BSD: a bare word of letters is an option cluster too (`ps aux`).
        if (!arg.startsWith('-') && i === 0 && /^[A-Za-z]+$/.test(arg)) {
            for (const c of cluster(arg)) {
                if (!'acdefjlmnrSTuvwxACEghMoOpPtU'.includes(c)) return { usage: `ps: illegal option -- ${c}` };
                applyPsFlag(o, c);
            }
            sawOption = true;
            i++;
            continue;
        }
        if (!arg.startsWith('-')) { i++; continue; }
        const letters = cluster(arg);
        let k = 0;
        while (k < letters.length) {
            const c = letters[k];
            if ('opUtGguO'.includes(c)) {
                let value = letters.slice(k + 1).join('');
                if (value === '') {
                    value = args[i + 1] ?? '';
                    i++;
                }
                if (value === '') return { usage: `ps: option requires an argument -- ${c}` };
                applyPsValue(o, c, value);
                k = letters.length;
            } else {
                if (!'acdefjlmnrSTvwxACEhM'.includes(c)) return { usage: `ps: illegal option -- ${c}` };
                applyPsFlag(o, c);
                k++;
            }
        }
        sawOption = true;
        i++;
    }
    // No options: the host shows the caller's own processes on its terminal. The container has one
    // user and no terminals, so "own" and "all" are the same set; show everything.
    if (!sawOption) o.all = true;
    return o;
}

function applyPsFlag(o: PsOptions, c: string): void {
    if (c === 'a' || c === 'd') o.all = true;
    else if (c === 'e' || c === 'A' || c === 'x') o.all = true;
    else if (c === 'f') o.full = true;
    else if (c === 'l') o.long = true;
    else if (c === 'j') o.jobs = true;
    else if (c === 'u') o.userFormat = true;
    else if (c === 'r' || c === 'm') o.sortCpu = true;
    else if (c === 'h') o.noHeader = true;
    else if (c === 'c' || c === 'C' || c === 'E' || c === 'M' || c === 'S' || c === 'T' || c === 'v' || c === 'w' || c === 'n' || c === 'g' || c === 'G') { /* accepted, no effect here */ }
}

function applyPsValue(o: PsOptions, c: string, value: string): void {
    if (c === 'o' || c === 'O') {
        o.format = value.split(/[,\s]+/).filter((f) => f !== '');
        o.noHeader = o.format.some((f) => f.endsWith('='));
    } else if (c === 'p') {
        o.pids = value.split(',').map((p) => Number(p.trim()));
        o.rawPids = value.split(',').map((p) => p.trim());
    } else if (c === 't') {
        o.ttys = value.split(',').map((t) => t.trim());
    } else if (c === 'u' || c === 'U') {
        o.users = value.split(',').map((u) => u.trim()).filter((u) => u !== '');
        o.all = true;
    }
}

function psSelect(o: PsOptions, procs: Proc[]): { rows: Proc[] } | { fatal: string } {
    let rows = procs;
    if (o.pids) {
        for (let k = 0; k < o.pids.length; k++) {
            const raw = o.rawPids?.[k] ?? String(o.pids[k]);
            if (!Number.isFinite(o.pids[k])) return { fatal: `ps: Invalid process id: ${raw}` };
            if (o.pids[k] > 99999) return { fatal: `ps: process id too large: ${o.pids[k]}` };
        }
        rows = rows.filter((p) => o.pids!.includes(p.pid));
    }
    if (o.users) {
        rows = o.users.includes(OWC_USER) || o.users.includes(String(OWC_UID)) ? rows : [];
    }
    if (o.ttys) rows = []; // the container has no terminals, so no process can be on one
    if (o.sortCpu) rows = rows.slice().sort((a, b) => b.cpuMs - a.cpuMs || a.pid - b.pid);
    return { rows };
}

/** Header and rows of the short format (`ps`, `ps -e`): PID, TTY, TIME, CMD. */
function psShort(rows: Proc[], noHeader: boolean): string {
    const lines: string[] = [];
    if (!noHeader) lines.push('  PID TTY           TIME CMD');
    for (const p of rows) {
        const time = clockTime(p.cpuMs);
        let line = pad(String(p.pid), 5) + ' ' + '??';
        line += ' '.repeat(Math.max(1, 24 - line.length - time.length)) + time;
        lines.push(line + ' ' + p.command);
    }
    return lines.join('\n');
}

function psFull(rows: Proc[], noHeader: boolean): string {
    const lines: string[] = [];
    if (!noHeader) lines.push('  UID   PID  PPID   C STIME   TTY           TIME CMD');
    for (const p of rows) {
        const time = clockTime(p.cpuMs);
        let line = pad(String(OWC_UID), 5) + ' ' + pad(String(p.pid), 5) + ' ' + pad(String(p.ppid), 5) +
            ' ' + pad('0', 3) + ' ' + padRight(PS_UNKNOWN_START, 7) + ' ' + '??';
        line += ' '.repeat(Math.max(1, 48 - line.length - time.length)) + time;
        lines.push(line + ' ' + p.command);
    }
    return lines.join('\n');
}

function psLong(rows: Proc[], noHeader: boolean): string {
    const lines: string[] = [];
    if (!noHeader) {
        lines.push('  UID   PID  PPID        F CPU PRI NI       SZ    RSS WCHAN     S             ADDR TTY           TIME CMD');
    }
    for (const p of rows) {
        const time = clockTime(p.cpuMs);
        let line = pad(String(OWC_UID), 5) + ' ' + pad(String(p.pid), 5) + ' ' + pad(String(p.ppid), 5) +
            ' ' + pad('0', 9) + ' ' + pad('0', 3) + ' ' + pad('0', 3) + ' ' + pad('0', 3) +
            ' ' + pad('0', 8) + ' ' + pad('0', 7) + ' ' + padRight('-', 9) + ' ' + padRight(statLetter(p.state), 1) +
            ' ' + pad('0', 17) + ' ' + '??';
        line += ' '.repeat(Math.max(1, 101 - line.length - time.length)) + time;
        lines.push(line + ' ' + p.command);
    }
    return lines.join('\n');
}

function psJobs(rows: Proc[], noHeader: boolean): string {
    const lines: string[] = [];
    if (!noHeader) lines.push('USER        PID  PPID  PGID   SESS JOBC STAT   TT       TIME COMMAND');
    for (const p of rows) {
        lines.push(
            padRight(OWC_USER, 10) + pad(String(p.pid), 5) + pad(String(p.ppid), 6) + pad(String(p.pid), 6) +
            pad('0', 7) + pad('1', 5) + ' ' + padRight(statLetter(p.state), 4) + pad('??', 5) +
            pad(clockTime(p.cpuMs), 11) + ' ' + p.command
        );
    }
    return lines.join('\n');
}

function psUser(rows: Proc[], noHeader: boolean): string {
    const lines: string[] = [];
    if (!noHeader) lines.push('USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND');
    for (const p of rows) {
        // Host note: macOS lays `aux` out with one column of slack that a 9-digit VSZ consumes; the
        // container reports 0, so the header and the rows line up exactly.
        lines.push(
            padRight(OWC_USER, 10) + pad(String(p.pid), 12) + pad('0.0', 6) + pad('0.0', 5) +
            pad('0', 10) + pad('0', 7) + pad('??', 5) + pad(statLetter(p.state), 4) +
            pad(PS_UNKNOWN_START, 10) + pad(clockTime(p.cpuMs), 10) + ' ' + p.command
        );
    }
    return lines.join('\n');
}

/** `-o` keywords: the widths the host gives them when nothing forces them wider. */
const PS_KEYWORDS: Record<string, { header: string; width: number; align: 'l' | 'r' }> = {
    pid: { header: 'PID', width: 5, align: 'r' },
    ppid: { header: 'PPID', width: 5, align: 'r' },
    pgid: { header: 'PGID', width: 5, align: 'r' },
    uid: { header: 'UID', width: 5, align: 'r' },
    gid: { header: 'GID', width: 5, align: 'r' },
    user: { header: 'USER', width: 8, align: 'l' },
    tty: { header: 'TTY', width: 8, align: 'l' },
    stat: { header: 'STAT', width: 4, align: 'l' },
    state: { header: 'STAT', width: 4, align: 'l' },
    time: { header: 'TIME', width: 9, align: 'r' },
    nice: { header: 'NI', width: 3, align: 'r' },
    pri: { header: 'PRI', width: 3, align: 'r' },
    pcpu: { header: '%CPU', width: 5, align: 'r' },
    '%cpu': { header: '%CPU', width: 5, align: 'r' },
    pmem: { header: '%MEM', width: 5, align: 'r' },
    '%mem': { header: '%MEM', width: 5, align: 'r' },
    vsz: { header: 'VSZ', width: 8, align: 'r' },
    rss: { header: 'RSS', width: 7, align: 'r' },
    wchan: { header: 'WCHAN', width: 9, align: 'l' },
    comm: { header: 'COMM', width: 16, align: 'l' },
    command: { header: 'COMMAND', width: 0, align: 'l' },
    args: { header: 'COMMAND', width: 0, align: 'l' },
    ucomm: { header: 'UCOMM', width: 16, align: 'l' }
};

function psFormat(rows: Proc[], format: string[], noHeader: boolean): string {
    const keys = format.map((f) => f.replace(/=.*$/, '').toLowerCase());
    const cols = keys.map((k) => PS_KEYWORDS[k] ?? { header: k.toUpperCase(), width: Math.max(4, k.length), align: 'l' as const });
    const values: string[][] = rows.map((p) => keys.map((k) => {
        switch (k) {
            case 'pid': return String(p.pid);
            case 'ppid': return String(p.ppid);
            case 'pgid': return String(p.pid);
            case 'uid': return String(OWC_UID);
            case 'gid': return String(OWC_GID);
            case 'user': return OWC_USER;
            case 'tty': return '??';
            case 'stat': case 'state': return statLetter(p.state);
            case 'time': return clockTime(p.cpuMs);
            case 'nice': case 'pri': return '0';
            case 'pcpu': case '%cpu': case 'pmem': case '%mem': return '0.0';
            case 'vsz': case 'rss': return '0';
            case 'wchan': return '-';
            case 'comm': case 'ucomm': return commOf(p.command);
            default: return p.command;
        }
    }));
    const widths = cols.map((c, i) => c.width === 0 ? 0 : Math.max(c.width, ...values.map((v) => v[i].length)));
    const render = (cells: string[]): string => cells
        .map((v, i) => widths[i] === 0 ? v : cols[i].align === 'r' ? pad(v, widths[i]) : padRight(v, widths[i]))
        .join(' ')
        .replace(/\s+$/, '');
    const lines: string[] = [];
    if (!noHeader) lines.push(render(cols.map((c) => c.header)));
    for (const v of values) lines.push(render(v));
    return lines.join('\n');
}

const ps: ShellCommand = (ctx) => {
    const h = hostOr();
    if (!h) return noHost('ps');
    const parsed = parsePs(ctx.args);
    if ('usage' in parsed) return fail(`${parsed.usage}\n${PS_USAGE}`, 1);
    const o = parsed as PsOptions;
    const all = procsOf(h);
    const selected = psSelect(o, all);
    if ('fatal' in selected) return fail(selected.fatal, 1);
    const rows = selected.rows;
    let body: string;
    if (o.format) body = psFormat(rows, o.format, o.noHeader);
    else if (o.userFormat) body = psUser(rows, o.noHeader);
    else if (o.long) body = psLong(rows, o.noHeader);
    else if (o.jobs) body = psJobs(rows, o.noHeader);
    else if (o.full) body = psFull(rows, o.noHeader);
    else body = psShort(rows, o.noHeader);
    // Selecting a pid that no process has is an error, but only when nothing else was selected.
    if (o.pids && rows.length === 0 && o.pids.length > 0) {
        return { stdout: body ? body + '\n' : '', stderr: '', exitCode: 1 };
    }
    return out(body);
};

/* ================================================================== *
 * 5. top
 * ================================================================== */

const TOP_USAGE = [
    'top usage: top',
    '\t\t[-a | -d | -e | -c <mode>]',
    '\t\t[-F | -f]',
    '\t\t[-h]',
    '\t\t[-i <interval>]',
    '\t\t[-l <samples>]',
    '\t\t[-ncols <columns>]',
    '\t\t[-o <key>] [-O <secondaryKey>]',
    '\t\t\tkeys: pid (default), command, cpu, cpu_me, cpu_others, csw,',
    '\t\t\t\ttime, threads, ports, mregion, mem, rprvt, purg, vsize, vprvt,',
    '\t\t\t\tkprvt, kshrd, pgrp, ppid, state, uid, wq, faults, cow, user,',
    '\t\t\t\tmsgsent, msgrecv, sysbsd, sysmach, pageins, boosts, instrs, cycles',
    '\t\t[-R | -r]',
    '\t\t[-S]',
    '\t\t[-s <delay>]',
    '\t\t[-n <nprocs>]'
].join('\n');

/** The default `-stats` set, in the host's order. */
const TOP_DEFAULT_STATS = [
    'pid', 'command', 'cpu', 'time', 'threads', 'wq', 'ports', 'mem', 'purg', 'cmprs', 'pgrp',
    'ppid', 'state', 'boosts', 'cpu_me', 'cpu_othrs', 'uid', 'faults', 'cow', 'msgsent', 'msgrecv',
    'sysbsd', 'sysmach', 'csw', 'pageins', 'idlew', 'power', 'instrs', 'cycles', 'jetpri', 'user',
    'mregion', 'rprvt', 'vprvt', 'vsize', 'kprvt', 'kshrd'
];

const TOP_STAT_HEADERS: Record<string, string> = {
    pid: 'PID', command: 'COMMAND', cpu: '%CPU', time: 'TIME', threads: '#TH', wq: '#WQ',
    ports: '#PORTS', mem: 'MEM', purg: 'PURG', cmprs: 'CMPRS', pgrp: 'PGRP', ppid: 'PPID',
    state: 'STATE', boosts: 'BOOSTS', cpu_me: '%CPU_ME', cpu_othrs: '%CPU_OTHRS', uid: 'UID',
    faults: 'FAULTS', cow: 'COW', msgsent: 'MSGSENT', msgrecv: 'MSGRECV', sysbsd: 'SYSBSD',
    sysmach: 'SYSMACH', csw: 'CSW', pageins: 'PAGEINS', idlew: 'IDLEW', power: 'POWER',
    instrs: 'INSTRS', cycles: 'CYCLES', jetpri: 'JETPRI', user: 'USER', mregion: '#MREGS',
    rprvt: 'RPRVT', vprvt: 'VPRVT', vsize: 'VSIZE', kprvt: 'KPRVT', kshrd: 'KSHRD'
};

/** Values the container cannot measure. The host prints N/A for these too. */
const TOP_STAT_NOT_AVAILABLE = new Set(['mem', 'mregion', 'rprvt', 'vprvt', 'vsize', 'kprvt', 'kshrd']);

function topStatValue(key: string, p: Proc): string {
    if (TOP_STAT_NOT_AVAILABLE.has(key)) return 'N/A';
    switch (key) {
        case 'pid': return String(p.pid);
        case 'command': return commOf(p.command);
        case 'cpu': return '0.0';
        case 'time': return clockTime(p.cpuMs).replace(/^(\d+):(\d\d)\.(\d\d)$/, (_m, mm: string, ss: string, cs: string) => `${mm.padStart(2, '0')}:${ss}.${cs}`);
        case 'threads': return '1';
        case 'wq': return '0';
        case 'ports': return '0';
        case 'purg': return '0B';
        case 'cmprs': return '0B';
        case 'pgrp': return String(p.pid);
        case 'ppid': return String(p.ppid);
        case 'state': return stateWord(p.state);
        case 'boosts': return '*0[0]';
        case 'cpu_me': return '0.00000';
        case 'cpu_othrs': return '0.00000';
        case 'uid': return String(OWC_UID);
        case 'power': return '0.0';
        case 'user': return OWC_USER;
        default: return '0';
    }
}

const top: ShellCommand = (ctx) => {
    const h = hostOr();
    if (!h) return noHost('top');
    let samples = 1;
    let nprocs = -1;
    let stats = TOP_DEFAULT_STATS;
    let sortKey = 'pid';
    let sortDesc = true;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const value = (): string => args[++i] ?? '';
        switch (a) {
            case '-l': {
                const v = value();
                if (!/^\d+$/.test(v)) return fail(`invalid option or syntax: -l ${v}\n${TOP_USAGE}`, 1);
                samples = Number(v); break; // a synchronous handler cannot sleep: one sample is all it takes
            }
            case '-n': case '-nprocs': {
                const v = value();
                if (!/^\d+$/.test(v)) return fail(`invalid option or syntax: ${a} ${v}\n${TOP_USAGE}`, 1);
                nprocs = Number(v); break;
            }
            case '-stats': {
                const v = value();
                if (v === '') return fail(`invalid option or syntax: -stats\n${TOP_USAGE}`, 1);
                stats = v.split(/[,\s]+/).filter((s) => s !== '');
                break;
            }
            case '-o': sortKey = value() || sortKey; sortDesc = false; break;
            case '-O': value(); break;
            case '-s': case '-i': {
                const v = value();
                if (!/^[\d.]+$/.test(v)) return fail(`invalid option or syntax: ${a} ${v}\n${TOP_USAGE}`, 1);
                break;
            }
            case '-pid': value(); break;
            case '-ncols': value(); break;
            case '-F': case '-f': case '-R': case '-r': case '-S': case '-a': case '-d': case '-e': case '-h': break;
            default:
                if (/^-c/.test(a)) { if (a === '-c') value(); break; }
                return fail(`invalid option or syntax: ${a}\n${TOP_USAGE}`, 1);
        }
    }
    if (samples < 1) samples = 1;

    let procs = procsOf(h);
    if (sortKey === 'pid' || sortKey === 'command') {
        procs = procs.sort((a, b) => sortDesc ? b.pid - a.pid : a.pid - b.pid);
    } else if (sortKey === 'cpu' || sortKey === 'time') {
        procs = procs.sort((a, b) => (sortDesc ? b.cpuMs - a.cpuMs : a.cpuMs - b.cpuMs) || b.pid - a.pid);
    }
    // The summary counts every process; -n only trims the rows, as on the host.
    const running = procs.filter((p) => stateWord(p.state) === 'running').length;
    const sleeping = procs.filter((p) => stateWord(p.state) === 'sleeping').length;
    const shown = nprocs >= 0 ? procs.slice(0, nprocs) : procs;
    const now = new Date(h.now());
    const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ` +
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const rows = shown.map((p) => stats.map((k) => topStatValue(k, p)));
    const widths = stats.map((k, i) => Math.max(TOP_STAT_HEADERS[k]?.length ?? k.length, ...rows.map((r) => r[i].length)) + 2);
    const render = (cells: string[]): string => cells.map((v, i) => i === cells.length - 1 ? v : padRight(v, widths[i])).join('');

    const lines: string[] = [];
    lines.push(`Processes: ${procs.length} total, ${running} running, ${sleeping} sleeping, ${procs.length} threads `);
    lines.push(stamp);
    lines.push('Load Avg: 0.00, 0.00, 0.00 ');
    lines.push('CPU usage: 0.0% user, 0.0% sys, 100.0% idle ');
    lines.push('');
    lines.push(render(stats.map((k) => TOP_STAT_HEADERS[k] ?? k.toUpperCase())));
    for (const r of rows) lines.push(render(r));
    return out(lines.join('\n'));
};

/* ================================================================== *
 * 6. kill
 * ================================================================== */

const KILL_USAGE = [
    'usage: kill [-s signal_name] pid ...',
    '       kill -l [exit_status]',
    '       kill -signal_name pid ...',
    '       kill -signal_number pid ...'
].join('\n');

const kill: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(KILL_USAGE, 2);
    if (args[0] === '-l' || (args[0].startsWith('-') && args[0].includes('l') && args.length === 1 && /^-[A-Za-z]*l[A-Za-z]*$/.test(args[0]))) {
        const arg = args[1];
        if (arg === undefined) return out(signalList(false));
        const n = Number(arg);
        if (!Number.isFinite(n)) return fail(KILL_USAGE, 2);
        const sig = n > 128 ? n - 128 : n;
        const name = SIGNAL_NAMES[sig - 1];
        if (!name) return fail(`kill: bad signal number: ${sig}`, 1);
        return out(name);
    }
    const h = hostOr();
    if (!h) return noHost('kill');

    let signal = 'TERM';
    let i = 0;
    if (args[0].startsWith('-') && args[0] !== '-') {
        const word = args[0].slice(1);
        if (args[0] === '-s') {
            signal = args[1] ?? '';
            i = 2;
            if (signal === '') return fail(KILL_USAGE, 2);
        } else if (word === 's') {
            signal = args[1] ?? '';
            i = 2;
        } else {
            signal = word;
            i = 1;
        }
        const resolved = resolveSignal(signal);
        if (!resolved) {
            return fail(`kill: unknown signal ${signal}; valid signals:\n${signalList(false)}`, 2);
        }
        signal = resolved;
    }
    const pids = args.slice(i);
    if (pids.length === 0) return fail(KILL_USAGE, 2);
    // `-0` only asks whether the process exists; the process list answers that without signalling.
    const exists = (pid: number): boolean => h.list().some((p) => p.pid === pid);
    let status = 0;
    const errors: string[] = [];
    for (const word of pids) {
        if (!/^\d+$/.test(word)) return fail(`kill: illegal process id: ${word}`, 2);
        const pid = Number(word);
        // The host names the pid the way a shell's own `kill` does: `kill: (999999) - No such process`.
        if (signal === '0') {
            if (!exists(pid)) { errors.push(`kill: (${pid}) - No such process`); status = 1; }
            continue;
        }
        if (!h.signal(pid, signal)) { errors.push(`kill: (${pid}) - No such process`); status = 1; }
    }
    return { stdout: '', stderr: errors.length ? errors.join('\n') + '\n' : '', exitCode: status };
};

/* ================================================================== *
 * 7. killall
 * ================================================================== */

const KILLALL_SIGNAL_ERROR = (word: string): string =>
    `killall: unknown signal ${word}; valid signals:\n${signalList(true)}`;

/** Matches the way the host's killall selects: by process name, or by regex with -m. */
function matchesName(p: Proc, name: string, useRegex: boolean, ignoreCase: boolean): boolean {
    const comm = commOf(p.command);
    if (useRegex) {
        try {
            return new RegExp(name, ignoreCase ? 'i' : '').test(comm);
        } catch {
            return false;
        }
    }
    return ignoreCase ? comm.toLowerCase() === name.toLowerCase() : comm === name;
}

const KILLALL_USAGE_TEXT = 'KILLALL_USAGE_TEXT';

const killall: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(KILLALL_USAGE_TEXT, 1);
    let signal = 'TERM';
    let useRegex = false;
    let ignoreCase = false;
    let quiet = false;
    const names: string[] = [];
    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') { i++; while (i < args.length) names.push(args[i++]); break; }
        if (a === '-l') return out(signalList(true, 17)); // the host splits its list after 17 names
        if (a === '-help') return fail(KILLALL_USAGE_TEXT, 1);
        if (a.startsWith('-') && a !== '-') {
            const body = a.slice(1);
            if (/^[A-Za-z]/.test(body) && !/^(u|t|c|s|m|I|q|v|d|e|z|l)$/.test(body)) {
                // -SIGNAL or an unknown option word: the host reads it as a signal name first.
                const resolved = resolveSignal(body);
                if (!resolved) return fail(KILLALL_SIGNAL_ERROR(body), 1);
                signal = resolved;
                i++;
                continue;
            }
            if (body === 'm') { useRegex = true; i++; continue; }
            if (body === 'I') { ignoreCase = true; i++; continue; }
            if (body === 'q') { quiet = true; i++; continue; }
            if (body === 's' || body === 'v' || body === 'd' || body === 'e' || body === 'z') { i++; continue; }
            if (body === 'u') {
                const user = args[i + 1] ?? '';
                i += 2;
                if (user !== OWC_USER && user !== 'root') return fail(`killall: user ${user} does not exist`, 1);
                continue;
            }
            if (body === 't') { i += 2; continue; }
            if (body === 'c') { i += 2; continue; }
            const resolved = resolveSignal(body);
            if (!resolved) return fail(KILLALL_SIGNAL_ERROR(body), 1);
            signal = resolved;
            i++;
            continue;
        }
        names.push(a);
        i++;
    }
    if (names.length === 0) return fail(KILLALL_USAGE_TEXT, 1);
    const h = hostOr();
    if (!h) return noHost('killall');
    const procs = procsOf(h);
    const targets = procs.filter((p) => names.some((n) => matchesName(p, n, useRegex, ignoreCase)));
    if (targets.length === 0) {
        // -q suppresses the message only; the host still reports failure through its exit status.
        if (quiet) return { stdout: '', stderr: '', exitCode: 1 };
        return fail('No matching processes belonging to you were found', 1);
    }
    let status = 0;
    for (const p of targets) if (!h.signal(p.pid, signal)) status = 1;
    return { stdout: '', stderr: '', exitCode: status };
};

/* ================================================================== *
 * 8. pkill
 * ================================================================== */

const PKILL_USAGE = [
    'usage: pkill [-signal] [-ILfilnovx] [-F pidfile] [-G gid]',
    '             [-P ppid] [-U uid] [-g pgrp] [-t tty] [-u euid]',
    '             pattern ...'
].join('\n');

const pkill: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(PKILL_USAGE, 2);
    let signal = 'TERM';
    let full = false;
    let ignoreCase = false;
    let listNames = false;
    const patterns: string[] = [];
    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (a === '--') { i++; while (i < args.length) patterns.push(args[i++]); break; }
        if (a.startsWith('-') && a !== '-') {
            const body = a.slice(1);
            const knownLetter = /^(I|L|f|i|l|n|o|v|x|U|P|G|g|t|u|F)$/.test(body);
            if (/^\d+$/.test(body) || (/^[A-Za-z]/.test(body) && !knownLetter)) {
                // A signal spec: `-9`, `-TERM`, and `-0` (the host's existence-only signal).
                const resolved = resolveSignal(body);
                if (!resolved) return fail(`pkill: illegal option -- ${body.replace(/^-/, '')}\n${PKILL_USAGE}`, 2);
                signal = resolved;
                i++;
                continue;
            }
            for (const c of body) {
                if (c === 'f') full = true;
                else if (c === 'i') ignoreCase = true;
                else if (c === 'l') listNames = true;
                else if (c === 'I' || c === 'L' || c === 'n' || c === 'o' || c === 'v' || c === 'x') continue;
                else if (c === 'U') {
                    const user = args[i + 1] ?? '';
                    i++;
                    if (user !== OWC_USER && user !== 'root' && user !== String(OWC_UID)) {
                        return fail(`pkill: Unknown user \`${user}'`, 2);
                    }
                } else if (c === 'P' || c === 'G' || c === 'g' || c === 't' || c === 'u' || c === 'F') {
                    i++; // valued option: consume it
                } else {
                    return fail(`pkill: illegal option -- ${c}\n${PKILL_USAGE}`, 2);
                }
            }
            i++;
            continue;
        }
        patterns.push(a);
        i++;
    }
    if (patterns.length === 0) return fail(PKILL_USAGE, 2);
    const h = hostOr();
    if (!h) return noHost('pkill');
    const regexes: RegExp[] = [];
    for (const p of patterns) {
        try {
            regexes.push(new RegExp(p, ignoreCase ? 'i' : ''));
        } catch (error: any) {
            const why = String(error?.message ?? '').replace(/^Invalid regular expression: \/.*\/: /, '');
            // BSD prints the pattern between a backtick and an apostrophe; the parenthesised
            // reason is its own regex engine's, which this container's RegExp words differently.
            return fail(`pkill: Cannot compile regular expression \`${p}' (${why})`, 2);
        }
    }
    const procs = procsOf(h);
    const targets = procs.filter((p) => {
        const hay = full ? p.command : commOf(p.command);
        return regexes.some((r) => r.test(hay));
    });
    if (targets.length === 0) {
        if (listNames) return fail('No matching processes belonging to you were found', 1);
        return { stdout: '', stderr: '', exitCode: 1 }; // the host's pkill is silent when nothing matched
    }
    let status = 0;
    for (const p of targets) if (!h.signal(p.pid, signal)) status = 1;
    return { stdout: '', stderr: '', exitCode: status };
};

/* ================================================================== *
 * 9. nice, nohup, time, watch -- the four that run something
 * ================================================================== */

function noRunner(name: string, utility: string): CommandResult {
    return fail(`${name}: ${utility}: cannot run a command: no runner is installed on the process host`, 127);
}

const NICE_USAGE = 'usage: nice [-n increment] utility [argument ...]';

const nice: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(NICE_USAGE, 1);
    let increment: number | null = null;
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        const a = args[i];
        if (a === '-n') {
            const v = args[i + 1] ?? '';
            if (!/^[+-]?\d+$/.test(v)) return fail(`nice: ${v}: invalid nice value`, 1);
            increment = Number(v);
            i += 2;
            continue;
        }
        if (a === '--') { i++; break; }
        if (/^--/.test(a)) {
            // Legacy form: `--5` is -n -5 on the host; a non-numeric tail is an invalid value,
            // which is what the host says for `--help`.
            const value = '-' + a.slice(2);
            if (!/^[+-]?\d+$/.test(value)) return fail(`nice: ${value}: invalid nice value`, 1);
            increment = Number(value);
            i++;
            continue;
        }
        if (/^-\d+$/.test(a)) {
            // Legacy form: `-5` is -n 5 on the host.
            increment = Number(a.slice(1));
            i++;
            continue;
        }
        return fail(`nice: illegal option -- ${a.slice(1)}\n${NICE_USAGE}`, 1);
    }
    const words = args.slice(i);
    if (words.length === 0) return fail(NICE_USAGE, 1);
    const result = runCommand(ctx, words);
    if (result === null) return noRunner('nice', words[0]);
    if (increment !== null && increment < 0) {
        // Lowering the priority needs privilege the container's single user does not have; the host
        // prints this and runs the utility anyway.
        return { ...result, stderr: 'nice: setpriority: Permission denied\n' + result.stderr };
    }
    return result;
};

const NOHUP_USAGE = 'usage: nohup [--] utility [arguments]';

/**
 * The measured host reports a `nohup` usage error with status 127; GNU coreutils reports 125. The
 * container reports 1, so that no command it implements ever ends in 127, which is the status a
 * name it does not have reports with. The text is the host's, unchanged.
 */
const nohup: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(NOHUP_USAGE, 1);
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        if (args[i] === '--') { i++; break; }
        return fail(`nohup: illegal option -- ${args[i].slice(1).charAt(0)}\n${NOHUP_USAGE}`, 1);
    }
    const words = args.slice(i);
    if (words.length === 0) return fail(NOHUP_USAGE, 1);
    const result = runCommand(ctx, words);
    if (result === null) return noRunner('nohup', words[0]);
    // Output already goes to the shell's stdout, not a terminal, so nohup.out is never needed.
    return result;
};

function bashTime(realMs: number): string {
    const seconds = (realMs / 1000).toFixed(3);
    return `\nreal\t0m${seconds}s\nuser\t0m0.000s\nsys\t0m0.000s\n`;
}

function posixTime(realMs: number): string {
    return `\nreal ${(realMs / 1000).toFixed(2)}\nuser 0.00\nsys 0.00\n`;
}

const TIME_USAGE = 'usage: time [-p] utility [argument ...]';

const time: ShellCommand = (ctx) => {
    const args = ctx.args;
    let posix = false;
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        if (args[i] === '--') { i++; break; }
        if (args[i] === '-p' || args[i] === '--portability') { posix = true; i++; continue; }
        return fail(`${TIME_USAGE}\ntime: illegal option -- ${args[i].slice(1)}`, 2);
    }
    const words = args.slice(i);
    const h = hostOr();
    if (words.length === 0) return fail(TIME_USAGE, 2);
    const clock = (): number => (h ? h.now() : Date.now());
    const start = clock();
    const result = runCommand(ctx, words);
    if (result === null) {
        // Shape only: real/user/sys, as the shell prints them. Nothing ran.
        return { stdout: '', stderr: posix ? posixTime(0) : bashTime(0), exitCode: 0 };
    }
    const elapsed = Math.max(0, clock() - start);
    return {
        stdout: result.stdout,
        stderr: (posix ? posixTime(elapsed) : bashTime(elapsed)) + result.stderr,
        exitCode: result.exitCode
    };
};

const WATCH_USAGE = [
    '',
    'Usage:',
    ' watch [options] command',
    '',
    'Options:',
    '  -n, --interval <secs>  seconds to wait between updates',
    '  -t, --no-title         turn off header',
    '  -b, --beep             beep if command has a non-zero exit',
    '  -c, --color            interpret ANSI color and style sequences',
    '  -C, --no-color         do not interpret ANSI color and style sequences',
    '  -d, --differences[=<permanent>]  highlight changes between updates',
    '  -e, --errexit          exit if command has a non-zero exit',
    '  -f, --follow           follow the output and do not clear the screen',
    '  -g, --chgexit          exit when output from command changes',
    '  -p, --precise          -n includes command running time',
    '  -r, --no-rerun         do not rerun the program on window resize',
    '  -q, --equexit <cycles> exit when output from command does not change',
    '  -s, --shotsdir         directory to store screenshots'
].join('\n');

const watch: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return fail(WATCH_USAGE.trimStart(), 1);
    let interval = 2;
    let title = true;
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        const a = args[i];
        if (a === '--') { i++; break; }
        if (a === '-h' || a === '--help') return out('\n' + WATCH_USAGE.trimStart());
        if (a === '-n' || a === '--interval') {
            const v = args[i + 1] ?? '';
            i += 2;
            if (!/^\d+(\.\d+)?$/.test(v)) return fail(`watch: failed to parse argument: '${v}': Invalid argument`, 1);
            interval = Number(v);
            continue;
        }
        if (a === '-t' || a === '--no-title') { title = false; i++; continue; }
        if (a === '-q' || a === '--equexit') { i += 2; continue; }
        if (a === '-d' || a === '--differences') { i++; continue; }
        if (/^-[bcefgprsvBC]+$/.test(a)) { i++; continue; }
        return fail(`watch: invalid option -- ${a.replace(/^--?/, '')}\n\n${WATCH_USAGE.trimStart()}`, 1);
    }
    const words = args.slice(i);
    if (words.length === 0) return fail(WATCH_USAGE.trimStart(), 1);
    const result = runCommand(ctx, words);
    if (result === null) return fail(`watch: ${words[0]}: cannot run a command: no runner is installed on the process host`, 1);
    // No terminal: there is nowhere to redraw to, so watch runs the command once and exits with it.
    const header = `Every ${interval.toFixed(1)}s: ${words.join(' ')}\n`;
    const body = result.stdout ? '\n' + result.stdout : '';
    return { stdout: title ? header + body : result.stdout, stderr: result.stderr, exitCode: result.exitCode };
};

/* ================================================================== *
 * 10. hostname, who, whoami, users, groups, tty
 * ================================================================== */

const HOSTNAME_USAGE = 'usage: hostname [-f] [-s | -d] [name-of-host]';

const hostname: ShellCommand = (ctx) => {
    let mode = 'default';
    let asked = false;
    for (const a of ctx.args) {
        if (!a.startsWith('-')) { asked = true; continue; }
        for (const c of a.slice(1)) {
            if (c === 's') mode = 'short';
            else if (c === 'f') mode = 'fqdn';
            else if (c === 'd') mode = 'domain';
            else return fail(`hostname: illegal option -- ${c}\n${HOSTNAME_USAGE}`, 1);
        }
    }
    const name = hostnameOf(ctx);
    if (asked) return fail('hostname: sethostname: Operation not permitted', 1); // the container is not root
    if (mode === 'short') return out(name.split('.')[0]);
    if (mode === 'domain') return out(name.includes('.') ? name.slice(name.indexOf('.') + 1) : name);
    return out(name);
};

/** The container's one session: its user, on the console, since the container started. */
function session(ctx: CommandContext): { name: string; line: string; at: number } {
    return { name: OWC_USER, line: 'console', at: Date.now() };
}

const WHO_USAGE = 'usage: who [-abdHlmpqrstTu] [am I] [file]';

const who: ShellCommand = (ctx) => {
    let header = false;
    let quiet = false;
    let boot = false;
    let idle = false;
    let onlyMine = false;
    let i = 0;
    const rest: string[] = [];
    while (i < ctx.args.length) {
        const a = ctx.args[i];
        if (a === 'am' && ctx.args[i + 1] === 'i') { onlyMine = true; i += 2; continue; }
        if (a.startsWith('-') && a !== '-') {
            for (const c of a.slice(1)) {
                if (c === 'H') header = true;
                else if (c === 'q') quiet = true;
                else if (c === 'b') boot = true;
                else if (c === 'u') idle = true;
                else if (c === 'm') onlyMine = true;
                else if ('adlprstT'.includes(c)) continue;
                else return fail(`who: illegal option -- ${c}\n${WHO_USAGE}`, 1);
            }
            i++;
            continue;
        }
        rest.push(a);
        i++;
    }
    if (rest.length > 0) return fail(WHO_USAGE, 1); // no utmp file to read
    const s = session(ctx);
    if (boot) {
        return out(`${' '.repeat(16)} ${padRight('system boot', 12)} ${padRight(utmpTime(s.at), 12)} `);
    }
    if (quiet) {
        const lines: string[] = [];
        for (let k = 0; k < 1; k += 4) {
            lines.push([OWC_USER].slice(k, k + 4).map((n) => padRight(n, 16)).join(' ').replace(/\s+$/, ''));
        }
        return out(lines.join('\n') + `\n# users = 1`);
    }
    const rows: string[] = [];
    if (header) rows.push(`${padRight('NAME', 16)} ${padRight('LINE', 12)} ${padRight('TIME', 12)} ${padRight('FROM', 16)}`);
    if (onlyMine) {
        rows.push(`${padRight(s.name, 16)} ${padRight('', 12)} ${padRight(utmpTime(s.at), 12)} `);
        return out(rows.join('\n'));
    }
    const time = utmpTime(s.at);
    rows.push(idle
        ? `${padRight(s.name, 16)} ${padRight(s.line, 12)} ${padRight(time, 12)}  ${padCenter('old', 5)}${pad('0', 9)} `
        : `${padRight(s.name, 16)} ${padRight(s.line, 12)} ${padRight(time, 12)} `);
    return out(rows.join('\n'));
};

const WHOAMI_USAGE = 'usage: whoami';

const whoami: ShellCommand = (ctx) => {
    if (ctx.args.length > 0) {
        if (ctx.args.some((a) => a.startsWith('-'))) return fail(`whoami: illegal option -- ${ctx.args[0].slice(1).charAt(0)}\n${WHOAMI_USAGE}`, 1);
        return fail(WHOAMI_USAGE, 1);
    }
    return out(OWC_USER);
};

const USERS_USAGE = 'usage: users';

const users: ShellCommand = (ctx) => {
    if (ctx.args.length > 0) return fail(USERS_USAGE, 1);
    return out(OWC_USER);
};

const GROUPS_USAGE = 'usage: groups [user]';

const groups: ShellCommand = (ctx) => {
    let asked: string | null = null;
    for (const a of ctx.args) {
        if (a.startsWith('-')) return fail(`groups: illegal option -- ${a.slice(1).charAt(0)}\n${GROUPS_USAGE}`, 1);
        asked = a;
    }
    const who_ = asked ?? OWC_USER;
    if (who_ !== OWC_USER && who_ !== 'root') return fail(`groups: ${who_}: no such user`, 1);
    const text = tryRead(ctx, '/etc/group');
    if (text === undefined) return out(who_);
    let primary = who_;
    const extra: string[] = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '' || line.startsWith('#')) continue;
        const [name, , gid, members = ''] = line.split(':');
        if (!name) continue;
        const isMember = members.split(',').map((m) => m.trim()).includes(who_);
        if (who_ === OWC_USER && Number(gid) === OWC_GID) primary = name;
        else if (isMember && name !== primary) extra.push(name);
    }
    return out([primary, ...extra].join(' '));
};

const TTY_USAGE = 'usage: tty [-s]';

const tty: ShellCommand = (ctx) => {
    let silent = false;
    for (const a of ctx.args) {
        if (a === '-s') { silent = true; continue; }
        return fail(`tty: illegal option -- ${a.slice(1).charAt(0)}\n${TTY_USAGE}`, 2);
    }
    if (silent) return { stdout: '', stderr: '', exitCode: 1 }; // no terminal, and -s asks for nothing else
    return { stdout: 'not a tty\n', stderr: '', exitCode: 1 };
};

/* ================================================================== *
 * 11. sync
 * ================================================================== */

const sync: ShellCommand = (ctx) => {
    // The host's sync ignores every argument and always succeeds; do the same, after asking the
    // file system to flush if it knows how.
    try {
        const flush = (ctx.fs as unknown as { flush?: () => void }).flush;
        if (typeof flush === 'function') flush.call(ctx.fs);
    } catch {
        /* a file system that cannot flush is not an error for sync */
    }
    return { stdout: '', stderr: '', exitCode: 0 };
};

/* ================================================================== *
 * 12. locate / slocate
 * ================================================================== */

const LOCATE_USAGE = 'usage: locate [-0Scims] [-l limit] [-d database] pattern ...\n\ndefault database: `/var/db/locate.database\' or $LOCATE_PATH';

function walkFs(ctx: CommandContext, dir: string, depth: number): string[] {
    if (depth > 32) return [];
    const found: string[] = [];
    let entries: string[] = [];
    try {
        entries = ctx.fs.listDirectory(dir);
    } catch {
        return found;
    }
    for (const entry of entries) {
        const path = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
        found.push(path);
        if (ctx.fs.isDirectory(path)) found.push(...walkFs(ctx, path, depth + 1));
    }
    return found;
}

function locateCommand(ctx: CommandContext): CommandResult {
    let nul = false;
    let count = false;
    let ignoreCase = false;
    let limit = Infinity;
    const patterns: string[] = [];
    let i = 0;
    while (i < ctx.args.length) {
        const a = ctx.args[i];
        if (a.startsWith('-') && a !== '-') {
            for (const c of a.slice(1)) {
                if (c === '0') nul = true;
                else if (c === 'c') count = true;
                else if (c === 'i') ignoreCase = true;
                else if (c === 's' || c === 'm' || c === 'S') continue;
                else if (c === 'l' || c === 'd') {
                    const v = ctx.args[i + 1] ?? '';
                    i++;
                    if (c === 'l') {
                        if (!/^\d+$/.test(v)) return fail(`locate: invalid limit: ${v}\n${LOCATE_USAGE}`, 1);
                        limit = Number(v);
                    }
                    continue;
                } else return fail(`locate: illegal option -- ${c}\n${LOCATE_USAGE}`, 1);
            }
            i++;
            continue;
        }
        patterns.push(ignoreCase ? a.toLowerCase() : a);
        i++;
    }
    if (patterns.length === 0) return fail(LOCATE_USAGE, 1);
    const all = walkFs(ctx, '/', 0);
    const hits = all
        .filter((p) => patterns.some((pat) => (ignoreCase ? p.toLowerCase() : p).includes(pat)))
        .sort()
        .slice(0, limit);
    if (hits.length === 0) return { stdout: '', stderr: '', exitCode: 1 }; // no match, silently
    if (count) return out(String(hits.length));
    return out(hits.join(nul ? '\0' : '\n'));
}

/* ================================================================== *
 * 13. vdir
 * ================================================================== */

const VDIR_USAGE = [
    "Usage: vdir [OPTION]... [FILE]...",
    "List information about the FILEs (the current directory by default).",
    "Try 'vdir --help' for more information."
].join('\n');

const MONTHS_FULL = MONTHS;

/** GNU ls -l date: `Oct 15 15:35` within six months, `Oct 15  2025` outside it. */
function longDate(ms: number): string {
    const d = new Date(ms);
    const sixMonths = 182 * 24 * 3600 * 1000;
    const age = Date.now() - ms;
    if (age < 0 || age > sixMonths) {
        return `${MONTHS_FULL[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getFullYear()).padStart(5, ' ')}`;
    }
    return `${MONTHS_FULL[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const vdir: ShellCommand = (ctx) => {
    const operands: string[] = [];
    for (const a of ctx.args) {
        if (a === '--') continue;
        if (a === '--help') return out(VDIR_USAGE);
        if (a.startsWith('-') && a !== '-') return fail(`vdir: invalid option -- '${a.replace(/^--?/, '')}'\n${VDIR_USAGE}`, 2);
        operands.push(a);
    }
    const targets = operands.length ? operands : ['.'];
    const blocks: string[] = [];
    const errors: string[] = [];
    let missing = false;
    for (const target of targets) {
        const path = atPath(ctx, target);
        const stat = tryStat(ctx, path);
        if (!stat) { errors.push(`vdir: cannot access '${target}': No such file or directory`); missing = true; continue; }
        if (stat.type === 'dir') {
            const names = ctx.fs.listDirectory(path).slice().sort();
            const rows = names.map((name) => {
                const child = tryStat(ctx, path === '/' ? `/${name}` : `${path}/${name}`);
                const isDir = child ? child.type === 'dir' : ctx.fs.isDirectory(path === '/' ? `/${name}` : `${path}/${name}`);
                const mode = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
                const size = String(child ? child.size : 0);
                return { mode, links: '1', owner: OWC_USER, group: OWC_USER, size, date: longDate(child ? child.mtimeMs : Date.now()), name };
            });
            const width = rows.reduce((w, r) => Math.max(w, r.size.length), 0);
            const body = rows.map((r) => `${r.mode} ${r.links} ${r.owner} ${r.group} ${pad(r.size, width)} ${r.date} ${r.name}`);
            blocks.push((targets.length > 1 ? `${target}:\n` : '') + `total 0\n` + body.join('\n'));
        } else {
            blocks.push(`-rw-r--r-- 1 ${OWC_USER} ${OWC_USER} ${pad(String(stat.size), 1)} ${longDate(stat.mtimeMs)} ${target}`);
        }
    }
    return {
        stdout: blocks.length ? blocks.join('\n\n') + '\n' : '',
        stderr: errors.length ? errors.join('\n') + '\n' : '',
        exitCode: missing ? 2 : 0
    };
};

/* ================================================================== *
 * 14. less / more -- pass-through pagers
 * ================================================================== */

function pagerCommand(name: string): ShellCommand {
    return (ctx) => {
        const operands: string[] = [];
        let number = false;
        const warnings: string[] = [];
        for (const a of ctx.args) {
            if (a === '-N' && name === 'less') { number = true; continue; }
            if (a === '--version' || a === '-V') {
                return out(`${name === 'less' ? 'less' : 'more'} 668 (POSIX regular expressions)`);
            }
            if (a.startsWith('-') && a !== '-') {
                warnings.push(`There is no ${a} option ("less --help" for help)`);
                continue;
            }
            operands.push(a);
        }
        let sources: { name: string; text: string }[];
        if (operands.length === 0) {
            sources = inputText(ctx);
        } else {
            sources = operands.map((file) => {
                const text = tryRead(ctx, atPath(ctx, file));
                return text === undefined ? { name: file, text: null } : { name: file, text };
            }) as { name: string; text: string }[];
        }
        const chunks: string[] = [];
        for (const source of sources) {
            if ((source as { text: string | null }).text === null) {
                // The host prints this on stdout and keeps going; `more` alone exits 1 for it.
                if (name === 'more') return fail(`${source.name}: No such file or directory`, 1);
                chunks.push(`${source.name}: No such file or directory`);
                continue;
            }
            const text = (source as { text: string }).text;
            chunks.push(number
                ? text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n')
                : text);
        }
        return { stdout: out(chunks.join('\n')).stdout, stderr: warnings.length ? warnings.join('\n') + '\n' : '', exitCode: 0 };
    };
}

/* ================================================================== *
 * 15. man
 * ================================================================== */

const MAN_USAGE = [
    'Usage:',
    ' man [-adho] [-t | -w] [-M manpath] [-P pager] [-S mansect]',
    '     [-m arch[:machine]] [-p [eprtv]] [mansect] page [...]',
    ' man -f page [...] -- Emulates whatis(1)',
    ' man -k page [...] -- Emulates apropos(1)'
].join('\n');

/**
 * The synopsis `man` prints for a name: a line some command of this container already prints.
 *
 * Nothing here was written for `man`. An entry is either the usage line of the module that
 * implements the command, or the one-line help `help <name>` carries for a builtin; the last two
 * groups are what shell.ts implements itself, read off its own `runShellBuiltin`.
 */
function manSynopsis(): Record<string, string> {
    return {
    ps: PS_USAGE,
    top: TOP_USAGE,
    kill: KILL_USAGE,
    killall: KILLALL_USAGE_TEXT,
    pkill: PKILL_USAGE,
    nice: NICE_USAGE,
    nohup: NOHUP_USAGE,
    time: TIME_USAGE,
    watch: WATCH_USAGE,
    hostname: HOSTNAME_USAGE,
    who: WHO_USAGE,
    whoami: WHOAMI_USAGE,
    users: USERS_USAGE,
    groups: GROUPS_USAGE,
    tty: TTY_USAGE,
    locate: LOCATE_USAGE,
    slocate: LOCATE_USAGE,
    vdir: VDIR_USAGE,
    man: MAN_USAGE,
    uname: UNAME_USAGE,
    uptime: UPTIME_USAGE,
    pgrep: PGREP_USAGE,
    timeout: TIMEOUT_USAGE,
    sh: SH_USAGE,
    ...TEXT_USAGE,
    ...FILE_USAGE,
    // shell.ts, case by case: it takes no options except the ones below
    echo: 'echo [arg ...]',
    cat: 'cat [file]',
    pwd: 'pwd',
    ls: 'ls [directory]',
    mkdir: 'mkdir [-p] directory ...',
    rm: 'rm [-r] file ...',
    rmdir: 'rmdir directory',
    touch: 'touch file',
    cd: 'cd [directory]',
    cp: 'cp source destination',
    mv: 'mv source destination',
    true: 'true',
    false: 'false',
    clear: 'clear',
    ifconfig: 'ifconfig [-a] [interface]'
    };
}

/** Every name this container implements: the modules' own tables and the shell's own builtins. */
function manImplemented(): Set<string> {
    return new Set([
        ...Object.keys(COMMANDS),
        ...Object.keys(TEXT_UTILS),
        ...Object.keys(FILE_UTILS),
        ...IMPLEMENTED_BUILTINS,
        'echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false'
    ]);
}

/** Indents a usage block four spaces, the way a manual page sets a synopsis under its heading. */
function indentBlock(text: string): string {
    const body = text
        .replace(/^usage:[ \t]*/i, '')
        .replace(/^(?:[ \t]*\n)+/, '')
        .replace(/\n$/, '');
    return (
        body
            .split('\n')
            .map((line) => (line === '' ? '' : `    ${line}`))
            .join('\n') + '\n'
    );
}

/**
 * The manual page for one name, or null when this container has none for it. A page is only ever
 * text this container already publishes: no option is listed that the command does not implement.
 */
function manPage(name: string): string | null {
    const help = HELP[name];
    if (help !== undefined) {
        const split = help.indexOf(' -- ');
        const args = split === -1 ? '' : help.slice(0, split).trim();
        const description = split === -1 ? help : help.slice(split + 4).trim();
        // `help` writes the name as part of the arguments, so it is not written twice
        const synopsis = args === name || args.startsWith(`${name} `) ? args : `${name} ${args}`.trimEnd();
        return `NAME\n    ${name} - ${description}\n\nSYNOPSIS\n    ${synopsis}\n\n`;
    }
    const usage = manSynopsis()[name];
    if (usage !== undefined) {
        return `NAME\n    ${name}\n\nSYNOPSIS\n${indentBlock(usage)}\n`;
    }
    if (manImplemented().has(name)) {
        return (
            `NAME\n    ${name}\n\nSYNOPSIS\n    ${name} [argument ...]\n\n` +
            `DESCRIPTION\n    ${name} is implemented by this container, which publishes no synopsis\n` +
            `    for it: only the options it implements are accepted.\n\n`
        );
    }
    return null;
}

/**
 * `man`: a page for every command this container implements, and the host's own answer -- "No manual
 * entry for <name>", status 1 -- for one it does not. The container ships no manual pages, so a page
 * is assembled from the command's own usage line and the `help` builtin's one-liner; nothing is
 * written for `man` alone and no option is documented that the command does not take.
 */
const man: ShellCommand = (ctx) => {
    const args = ctx.args;
    if (args.length === 0) return { stdout: '', stderr: '', exitCode: 0 }; // "What manual page do you want?" needs a terminal
    let keyword = false;
    const pages: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-') && a !== '-') {
            for (const c of a.slice(1)) {
                if (c === 'k' || c === 'f') keyword = true;
                else if ('adhowt'.includes(c)) continue;
                else if ('MSmP'.includes(c)) i++;
                else return fail(`/usr/bin/man: illegal option -- ${c}\n${MAN_USAGE}`, 1);
            }
            continue;
        }
        pages.push(a);
    }
    if (pages.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
    if (keyword) return fail(`${pages[0]}: nothing appropriate`, 1);
    const found: string[] = [];
    const missing: string[] = [];
    for (const page of pages) {
        const text = manPage(page);
        if (text === null) missing.push(page);
        else found.push(text);
    }
    return {
        stdout: found.join(''),
        stderr: missing.length === 0 ? '' : `No manual entry for ${missing.join(' ')}\n`,
        exitCode: missing.length === 0 ? 0 : 1
    };
};

/* ================================================================== *
 * 15b. clear
 * ================================================================== */

/**
 * The bytes `clear` writes: erase the scrollback, home the cursor, erase the screen. Measured from
 * the host's `clear` on a terminal named by `TERM=xterm` -- the sequence an xterm terminal, which is
 * what the playground is, reads as "clear". It is written to stdout whatever stdout is: a pipe or a
 * file receives the same bytes and is none the worse for them, which is all a non-terminal can ask.
 */
const CLEAR_SEQUENCE = '\u001b[3J\u001b[H\u001b[2J';

/** `clear`: no options, because this container's `clear` takes none. */
const clear: ShellCommand = (ctx) => {
    if (ctx.args.length > 0) return fail(`clear: illegal option -- ${ctx.args[0].replace(/^-/, '')}`, 1);
    return { stdout: CLEAR_SEQUENCE, stderr: '', exitCode: 0 };
};

/* ================================================================== *
 * 15c. ifconfig
 * ================================================================== */

/**
 * One interface block, built from the hub state `ifconfig` was handed.
 *
 * `VirtualNetwork` is loopback-only: `isLocal` accepts the wildcard, `127.0.0.1` and every `127.*`
 * address, and a bind anywhere else fails EADDRNOTAVAIL while a connect fails ENETUNREACH. That
 * range, 127.0.0.0/8, is the whole of what the container can address, so it is one interface and it
 * is a loopback, and the name `lo` is the one a host gives that interface -- the hub itself names
 * nothing. `::1` resolves in the hub's name table but `isLocal` rejects it, so no IPv6 address is
 * claimed here either.
 *
 * The `inet` lines and the two lists under them are the hub's own tables read at this instant: the
 * addresses it is carrying on a binding or an open connection, the listeners and sockets it holds
 * and the connections that are open. Nothing here is counted, averaged or invented -- a number
 * printed is a number the hub really holds, and a hub that holds nothing prints the loopback alone.
 *
 * Where the shell was given no hub to read, that is what is printed too, and it is the reason: the
 * container's network state lives in the hub, and a list written here instead would be a list no
 * code in the container ever held.
 */
function ifconfigBlock(state: HubState | null): string {
    if (state === null) return 'lo: <UP,LOOPBACK>\n\tinet 127.0.0.1 netmask 255.0.0.0\n';
    const addresses = state.addresses.length === 0 ? ['127.0.0.1'] : state.addresses;
    let out = 'lo: <UP,LOOPBACK>\n';
    for (const address of addresses) {
        out += `\tinet ${address} netmask ${address.startsWith('127.') ? '255.0.0.0' : '0.0.0.0'}\n`;
    }
    out += '\tstatus: active\n';
    if (state.listeners.length > 0) {
        out += '\tlisteners:\n';
        for (const entry of state.listeners) out += `\t\t${entry.address}:${entry.port} (${entry.protocol})\n`;
    }
    if (state.connections.length > 0) {
        out += '\tconnections:\n';
        for (const entry of state.connections) out += `\t\t${entry.local} -> ${entry.remote}\n`;
    }
    return out;
}

/** `ifconfig`: `-a` and one interface name, the two things this container can answer. */
const ifconfig: ShellCommand = (ctx) => {
    const names: string[] = [];
    for (const arg of ctx.args) {
        if (arg === '-a' || arg === '--all') continue;
        if (arg.startsWith('-') && arg !== '-') {
            for (const c of arg.slice(1)) {
                if (c === 'a') continue;
                return fail(`ifconfig: illegal option -- ${c}\n${'usage: ifconfig [-a] [interface]'}\n`, 1);
            }
            continue;
        }
        names.push(arg);
    }
    for (const name of names) {
        if (name !== 'lo') return fail(`ifconfig: interface ${name} does not exist`, 1);
    }
    return { stdout: ifconfigBlock(ctx.network === undefined ? null : ctx.network()), stderr: '', exitCode: 0 };
};

/* ================================================================== *
 * 16. open
 * ================================================================== */

const OPEN_USAGE = [
    'Usage: open [-e] [-t] [-f] [-W] [-R] [-n] [-g] [-h] [-s <partial SDK name>][-b <bundle identifier>] [-a <application>] [-u URL] [filenames] [--args arguments]',
    'Help: Open opens files from a shell.',
    '      By default, opens each file using the default application for that file.',
    '      If the file is in the form of a URL, the file will be opened as a URL.'
].join('\n');

/** No desktop: `open` reports the missing file, or the missing session for a file that exists. */
const open: ShellCommand = (ctx) => {
    const operands: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
        const a = ctx.args[i];
        if (a === '--args') break;
        if (a.startsWith('-') && a !== '-') {
            const body = a.slice(1);
            if (body === 'a' || body === 'b' || body === 's' || body === 'u' || body === 'h') { i++; continue; }
            if (/^[e t f W R n g]+$/.test(body)) continue;
            return fail(`open: invalid option -- ${body}\n${OPEN_USAGE}`, 1);
        }
        operands.push(a);
    }
    if (operands.length === 0) return fail(OPEN_USAGE, 1);
    for (const operand of operands) {
        if (operand.includes(':')) return fail(`open: no desktop session is available in this container`, 1);
        if (!ctx.fs.fileExists(atPath(ctx, operand))) return fail(`The file ${operand} does not exist.`, 1);
    }
    return fail('open: no desktop session is available in this container', 1);
};

/* ================================================================== *
 * 17. xclip
 * ================================================================== */

const XCLIP_USAGE = [
    'Usage: xclip [OPTION] [FILE]...',
    'Access an X server selection for reading or writing.',
    '  -i, -in          read text into X selection from stdin or files (default)',
    '  -o, -out         print the selection to standard out',
    '  -f, -filter      filter text: print to stdout, write to selection',
    '  -r, -rmlastnl    remove the last newline character',
    '  -l, -loops       number of selection requests to wait for before exiting',
    '  -t, -target      specify the selection target',
    '  -d, -display     X display to connect to (default: $DISPLAY)',
    '  -s, -selection   selection to access: primary, secondary or clipboard',
    '  -n, -nounbuffered do not buffer the output',
    '  -silent          fork into the background and wait for requests',
    '  -q, -quiet       do not print informational messages',
    '  -v, -verbose     print informational messages',
    '  -h, -help        print this help and exit',
    '  -version         print version information and exit'
].join('\n');

/** No X server: every real xclip operation fails with the display error, as on a headless host. */
const xclip: ShellCommand = (ctx) => {
    for (let i = 0; i < ctx.args.length; i++) {
        const a = ctx.args[i];
        if (a === '-h' || a === '-help' || a === '--help') return out(XCLIP_USAGE);
        if (a === '-version' || a === '--version') return out('xclip version 0.13\nCopyright (C) 2001-2008 Kim Saunders et al.\nDistributed under the terms of the GNU GPL');
        if (!a.startsWith('-') || a === '-') continue;
        const body = a.replace(/^--?/, '');
        if (body === 'i' || body === 'in' || body === 'o' || body === 'out' || body === 'f' || body === 'filter' ||
            body === 'r' || body === 'rmlastnl' || body === 'n' || body === 'nounbuffered' || body === 'silent' ||
            body === 'q' || body === 'quiet' || body === 'v' || body === 'verbose') continue;
        if (body === 'l' || body === 'loops' || body === 't' || body === 'target' || body === 's' || body === 'selection') { i++; continue; }
        if (body === 'd' || body === 'display') { i++; continue; }
        return fail(`xclip: Error: Can't open display: (null)\n${XCLIP_USAGE}`, 1);
    }
    try {
        inputText(ctx); // the host blocks reading its input; do it before failing on the display
    } catch {
        /* a missing file is reported by the display error anyway */
    }
    return fail("xclip: Error: Can't open display: (null)", 1);
};

/* ================================================================== *
 * 17b. uname, uptime, w, pgrep, timeout and sh
 * ================================================================== */

/**
 * The container's own identity, as the guest's own `os` reports it: `os.type()` is Linux,
 * `os.release()` is 6.0.0 and `os.arch()` is x64, which `uname -m` spells `x86_64`. The host this
 * was measured on is macOS and prints its own; the shape -- one line, the fields space-separated,
 * `-a` in the order `s n r v m` -- is the host's.
 */
const OWC_SYSNAME = 'Linux';
const OWC_RELEASE = '6.0.0';
const OWC_VERSION = '#1 SMP OpenWebContainer 6.0.0';
const OWC_MACHINE = 'x86_64';

const UNAME_USAGE = 'usage: uname [-amnoprsv]';

const uname: ShellCommand = (ctx) => {
    let wanted = '';
    for (const arg of ctx.args) {
        if (!arg.startsWith('-') || arg === '-') return fail(`uname: illegal option -- ${arg.charAt(1)}\n${UNAME_USAGE}`, 1);
        for (const ch of arg.slice(1)) {
            // `-o` is not a field this uname reports; the measured host accepts it and prints the
            // default, which is what happens here: it selects nothing.
            if (ch === 'o') continue;
            if (!'amnprsv'.includes(ch)) return fail(`uname: illegal option -- ${ch}\n${UNAME_USAGE}`, 1);
            if (!wanted.includes(ch)) wanted += ch;
        }
    }
    const host = hostnameOf(ctx);
    const fields: Record<string, string> = {
        s: OWC_SYSNAME,
        n: host,
        r: OWC_RELEASE,
        v: OWC_VERSION,
        m: OWC_MACHINE,
        p: OWC_MACHINE
    };
    const order = wanted.includes('a') ? 'snrvm' : wanted;
    const shown = (order === '' ? 's' : order).split('').map((ch) => fields[ch]);
    return out(shown.join(' '));
};

/** `1:32`, `37 days,  1:32` or `0 mins`: the duration the host `uptime` prints after `up `. */
function upDuration(ms: number): string {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const minutes = Math.floor(safe / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return `${days} day${days === 1 ? '' : 's'},  ${hours}:${String(minutes % 60).padStart(2, '0')}`;
    if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, '0')}`;
    return `${minutes} min${minutes === 1 ? '' : 's'}`;
}

/**
 * The line `uptime` and the head of `w` print. The container has no boot clock and no load, so the
 * duration is 0 and the three averages are 0.00: reported, never invented.
 */
function uptimeLine(ctx: CommandContext, users: number): string {
    const now = new Date();
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return `${clock}  up ${upDuration(0)}, ${users} user${users === 1 ? '' : 's'}, load averages: 0.00 0.00 0.00`;
}

const UPTIME_USAGE = 'usage: uptime';

const uptime: ShellCommand = (ctx) => {
    // The host ignores the operands it is given and always prints the one line.
    for (const arg of ctx.args) {
        if (arg.startsWith('-') && arg !== '-') return fail(`uptime: illegal option -- ${arg.slice(1, 2)}\n${UPTIME_USAGE}`, 1);
    }
    return out(uptimeLine(ctx, 1));
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The `LOGIN@` column: `Thu15` inside the last week, `08Oct26` before that. Both shapes were read
 * off the host.
 */
function loginAt(at: number): string {
    const then = new Date(at);
    if (Date.now() - at < 7 * 24 * 60 * 60 * 1000) {
        return `${WEEKDAYS[then.getDay()]}${String(then.getHours()).padStart(2, '0')}`;
    }
    return `${String(then.getDate()).padStart(2, '0')}${MONTHS[then.getMonth()]}${String(then.getFullYear() % 100).padStart(2, '0')}`;
}

const W_HEADER = 'USER       TTY      FROM    LOGIN@  IDLE WHAT';

const wCommand: ShellCommand = (ctx) => {
    let header = true;
    let onlyMine = false;
    let idleOnly = false;
    const names: string[] = [];
    for (const arg of ctx.args) {
        if (arg === 'am' || arg === 'i') continue;
        if (arg.startsWith('-') && arg !== '-') {
            for (const ch of arg.slice(1)) {
                if (ch === 'h') header = false;
                else if (ch === 'u') idleOnly = true;
                else if (ch === 'm') onlyMine = true;
                else if ('fis'.includes(ch)) continue;
                else return fail(`w: illegal option -- ${ch}\nusage: w [-fhimsu] [user]`, 1);
            }
            continue;
        }
        names.push(arg);
    }
    const session_ = session(ctx);
    if (names.length > 0 && !names.includes(OWC_USER)) {
        return out(header ? uptimeLine(ctx, 1) + '\n' + W_HEADER + '\n' : '');
    }
    // `-u` sorts the idle time to the front of each row; with one session there is nothing to sort.
    if (idleOnly || onlyMine) { /* the container's one session is always the one asked for */ }
    const row =
        padRight(session_.name, 9) + '  ' +
        padRight(session_.line, 7) + '  ' +
        padRight('-', 7) + ' ' +
        padRight(loginAt(session_.at), 7) + ' ' +
        pad('-', 6) + ' ' +
        '-';
    const text = (header ? uptimeLine(ctx, 1) + '\n' + W_HEADER + '\n' : '') + row + '\n';
    return out(text);
};

const PGREP_USAGE = [
    'usage: pgrep [-Lfilnoqvx] [-d delim] [-F pidfile] [-G gid]',
    '             [-P ppid] [-U uid] [-g pgrp] [-t tty] [-u euid]',
    '             pattern ...'
].join('\n');

/** The name `pgrep` matches against without `-f`: the first word of the command. */
function procName(command: string): string {
    const first = command.trim().split(/\s+/)[0] ?? '';
    return first.slice(first.lastIndexOf('/') + 1);
}

const pgrep: ShellCommand = (ctx) => {
    const args = ctx.args;
    let listNames = false;
    let full = false;
    let exact = false;
    let newest = false;
    let oldest = false;
    let invert = false;
    let countOnly = false;
    let quiet = false;
    let delimiter = '\n';
    let i = 0;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        const arg = args[i];
        if (arg === '--') { i++; break; }
        for (const ch of arg.slice(1)) {
            if (ch === 'l') listNames = true;
            else if (ch === 'f') full = true;
            else if (ch === 'x') exact = true;
            else if (ch === 'n') newest = true;
            else if (ch === 'o') oldest = true;
            else if (ch === 'v') invert = true;
            else if (ch === 'c') countOnly = true;
            else if (ch === 'q') quiet = true;
            else if (ch === 'i') continue;
            else if (ch === 'd') { delimiter = args[i + 1] ?? '\n'; i++; }
            else if ('GPUsgUt'.includes(ch)) { i++; }
            else return fail(`pgrep: illegal option -- ${ch}\n${PGREP_USAGE}`, 2);
        }
        i++;
    }
    const patterns = args.slice(i);
    if (patterns.length === 0) return fail(PGREP_USAGE, 2);
    const h = hostOr();
    if (h === null) return noHost('pgrep');
    let matched: { pid: number; name: string; command: string }[] = [];
    for (const pattern of patterns) {
        let re: RegExp;
        try {
            re = new RegExp(exact ? `^${pattern}$` : pattern);
        } catch {
            return fail(`pgrep: ${pattern}: invalid regular expression`, 2);
        }
        const found = h.list().filter((p) => re.test(full ? p.command : procName(p.command)));
        for (const p of found) {
            if (matched.some((m) => m.pid === p.pid)) continue;
            matched.push({ pid: p.pid, name: procName(p.command), command: p.command });
        }
    }
    if (invert) {
        const all = h.list();
        matched = all
            .filter((p) => !matched.some((m) => m.pid === p.pid))
            .map((p) => ({ pid: p.pid, name: procName(p.command), command: p.command }));
    }
    if (newest) matched = matched.slice(-1);
    if (oldest) matched = matched.slice(0, 1);
    if (quiet) return { stdout: '', stderr: '', exitCode: matched.length === 0 ? 1 : 0 };
    if (countOnly) {
        return { stdout: String(matched.length) + '\n', stderr: '', exitCode: matched.length === 0 ? 1 : 0 };
    }
    if (matched.length === 0) return { stdout: '', stderr: '', exitCode: 1 };
    const text = matched.map((m) => (listNames ? `${m.pid} ${m.name}` : String(m.pid))).join(delimiter) + '\n';
    return { stdout: text, stderr: '', exitCode: 0 };
};

const TIMEOUT_USAGE = 'usage: timeout [-s signal | --signal=signal] [-k duration] [--preserve-status]\n' +
    '               [--foreground] [-v] duration command [arg ...]';

/** `5`, `5s`, `2m`, `1h`, `1d`: the duration `timeout` takes, in milliseconds. */
function timeoutMs(word: string): number | null {
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(word);
    if (match === null) return null;
    const factors: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Number(match[1]) * (match[2] === '' ? 1000 : factors[match[2]]);
}

/** The signals a `-s` may name, with the numbers the status of a killed command is built from. */
const SIGNAL_NUMBERS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, ALRM: 14, TERM: 15, USR1: 30, USR2: 31 };

/** The number of the signal a `-s` names: `TERM`, `SIGKILL`, `9`. Null for one the host has not. */
function signalNumber(word: string): number | null {
    if (/^\d+$/.test(word)) return Number(word);
    return SIGNAL_NUMBERS[word.toUpperCase().replace(/^SIG/, '')] ?? null;
}

/**
 * `timeout`: the duration, then the command, and the status of one that ran over its duration.
 *
 * A command here runs to completion before anything looks at the clock, because there is nothing
 * else it can do: the container has no signal to deliver and no way to interrupt a command that is
 * still running. So the deadline is measured *after* the command, on the wall clock, and a command
 * that took longer than the duration it was given reports the status the host's `timeout` reports
 * for one it killed at that instant -- 124, or 128 plus the signal for a `-s` or a
 * `--preserve-status`. What is not the same is the run itself: the host kills the command at the
 * deadline and this one finishes it, so its output here is the whole output, not the part it had
 * written when the deadline passed.
 */
const timeout: ShellCommand = (ctx) => {
    const args = ctx.args;
    let i = 0;
    let signal = 15;
    let signalGiven = false;
    let preserve = false;
    let verbose = false;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        const arg = args[i];
        if (arg === '--') { i++; break; }
        if (arg === '-s' || arg === '--signal') {
            const number = signalNumber(args[i + 1] ?? '');
            if (number === null) return fail(`timeout: invalid signal ${args[i + 1] ?? ''}\n${TIMEOUT_USAGE}`, 125);
            signal = number;
            signalGiven = true;
            i += 2;
            continue;
        }
        if (arg.startsWith('--signal=')) {
            const number = signalNumber(arg.slice('--signal='.length));
            if (number === null) return fail(`timeout: invalid signal ${arg.slice('--signal='.length)}\n${TIMEOUT_USAGE}`, 125);
            signal = number;
            signalGiven = true;
            i++;
            continue;
        }
        if (arg === '-k' || arg === '--kill-after') { i += 2; continue; }
        if (arg.startsWith('--kill-after=')) { i++; continue; }
        if (arg === '--preserve-status') { preserve = true; i++; continue; }
        if (arg === '--foreground') { i++; continue; }
        if (arg === '-v' || arg === '--verbose') { verbose = true; i++; continue; }
        if (arg === '--help') return out(TIMEOUT_USAGE);
        return fail(`timeout: illegal option -- ${arg.slice(1, 2)}\n${TIMEOUT_USAGE}`, 1);
    }
    const duration = args[i];
    if (duration === undefined) return fail(TIMEOUT_USAGE, 125);
    const ms = timeoutMs(duration);
    if (ms === null) return fail(`timeout: invalid time interval '${duration}'\n${TIMEOUT_USAGE}`, 125);
    const words = args.slice(i + 1);
    if (words.length === 0) return fail(TIMEOUT_USAGE, 125);
    const startedAt = Date.now();
    const result = runCommand(ctx, words);
    const elapsed = Date.now() - startedAt;
    if (result === null) return noRunner('timeout', words[0]);
    if (elapsed < ms) return result;
    const status = signalGiven || preserve ? 128 + signal : 124;
    const name = Object.keys(SIGNAL_NUMBERS).find((key) => SIGNAL_NUMBERS[key] === signal) ?? String(signal);
    const note = verbose ? `timeout: sending signal ${name} to command ‘${words[0]}’\n` : '';
    return { stdout: result.stdout, stderr: result.stderr + note, exitCode: status };
};

const SH_USAGE = 'usage: sh [-c string | -s | file] [argument ...]';

/**
 * `sh`: a new shell over the same file system, directory and environment.
 *
 * The context carries none of the script engine's state, so a fresh one is built for the script --
 * which is what `sh` really starts -- and the shell object the installed runner reads `host` for is
 * rebuilt from the context, the way `runWithRunner` does it. Variables and the working directory
 * therefore do not leak back to the shell that ran `sh`, exactly as they do not across a real one.
 */
function runShScript(ctx: CommandContext, source: string, name: string, positional: string[]): CommandResult {
    const state = createShellState(ctx.env ?? {}, ctx.cwd ?? '/', ctx.fs as unknown as ShellFs);
    state.shellName = name;
    state.positional = positional;
    state.host = {
        ctx: { fileSystem: ctx.fs },
        cwd: ctx.cwd ?? '/',
        env: ctx.env ?? {},
        input: ctx.input ?? null,
        lastStatus: 0
    };
    const run = runScript(state, source);
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
}

const sh: ShellCommand = (ctx) => {
    const args = ctx.args;
    let i = 0;
    let errexit = false;
    let nounset = false;
    let mode: 'c' | 's' | null = null;
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
        const arg = args[i];
        if (arg === '-c') { mode = 'c'; i++; break; }
        if (arg === '-s') { mode = 's'; i++; break; }
        for (const ch of arg.slice(1)) {
            if (ch === 'e') errexit = true;
            else if (ch === 'u') nounset = true;
            else return fail(`sh: illegal option -- ${ch}\n${SH_USAGE}`, 2);
        }
        i++;
    }
    // `-e` and `-u` are carried into the script as a `set` line, so the script's own state has them.
    const preamble = errexit || nounset
        ? `set ${[errexit ? '-e' : '', nounset ? '-u' : ''].filter((flag) => flag !== '').join(' ')}\n`
        : '';
    if (mode === 'c') {
        const source = args[i];
        if (source === undefined) return fail(`sh: -c: option requires an argument\n${SH_USAGE}`, 2);
        const rest = args.slice(i + 1);
        return runShScript(ctx, preamble + source, rest[0] ?? 'sh', rest.slice(1));
    }
    if (mode === 's') return runShScript(ctx, preamble + (ctx.input ?? ''), 'sh', args.slice(i));
    if (i >= args.length) return runShScript(ctx, preamble + (ctx.input ?? ''), 'sh', []);
    const file = args[i];
    const path = atPath(ctx, file);
    const text = tryRead(ctx, path);
    if (text === undefined) return fail(`sh: ${file}: No such file or directory`, 127);
    return runShScript(ctx, preamble + text, file, args.slice(i + 1));
};

/* ================================================================== *
 * 18. Table
 * ================================================================== */

export const COMMANDS: Record<string, ShellCommand> = {
    ps,
    top,
    kill,
    killall,
    pkill,
    nice,
    nohup,
    time,
    watch,
    hostname,
    who,
    whoami,
    users,
    groups,
    tty,
    sync,
    locate: locateCommand,
    slocate: locateCommand,
    vdir,
    less: pagerCommand('less'),
    more: pagerCommand('more'),
    man,
    open,
    xclip,
    uname,
    uptime,
    w: wCommand,
    pgrep,
    timeout,
    sh,
    clear,
    ifconfig
};
