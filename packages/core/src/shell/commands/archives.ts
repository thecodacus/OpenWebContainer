/**
 * Archive and compression utilities for the OWC guest shell.
 *
 * Every command here is a synchronous handler: it reads and writes through the virtual file system
 * handed to it in the context and never spawns a child. The module exports one record, `COMMANDS`,
 * which the shell's dispatcher consults before falling back to a spawned process.
 *
 * Codecs. The container ships fflate (DEFLATE/gzip/zlib), pako (DEFLATE/gzip/zlib) and jszip (zip
 * container only). Those cover gzip, gunzip and zcat, and nothing else in this file's remit:
 *
 *   - bzip2 / bunzip2 / bzcat  unsupported: no bzip2 codec (Burrows-Wheeler + Huffman) exists among
 *                              fflate, pako or jszip. Reported, never approximated.
 *   - xz / unxz / xzcat        unsupported: no LZMA2 codec exists among those three either.
 *
 * `compress`/`uncompress` are LZW, which the host `compress` also speaks; that codec is small
 * enough to carry here, so it is implemented rather than reported.
 *
 * Binary on the text-typed streams. The shell hands a command a string and takes a string back, so
 * a byte string has to be carried as text. Bytes that form a well-formed UTF-8 sequence are carried
 * as that sequence's code point; every other byte 0x80..0xff is carried as a private-use code point
 * at 0xf700+b. That makes text -> bytes -> text the identity on *every* byte string, so
 * `gzip -c | gunzip -c` round-trips exactly (fileutils' own codec is not a bijection and drops
 * bytes on such a pipe). Text output is unaffected: ASCII is ASCII and real UTF-8 is still UTF-8.
 *
 * Safety. Extractors never write outside the directory they were pointed at. A tar or cpio member
 * whose name resolves above that directory through `..` is refused outright, matching bsdtar's
 * "Path contains '..'" refusal rather than a `..`-stripping rewrite that would silently move the
 * payload. Absolute member names have their leading `/` removed, as both bsdtar and GNU tar do.
 *
 * File system limits. The virtual file system carries no owner, no permission bits, no link count
 * and no symlinks, so: modes and mtimes are written into archives from what `statPath` reports and
 * restored only when the file system happens to expose `chmod`/`utimes` (duck-typed, never
 * required); uid/gid/uname/gname are written as root; hard links are stored as plain files; and a
 * symlink member is written back as a regular file holding the link target, which cannot escape the
 * extraction directory. Where the file system does expose `readlink`, tar emits a real symlink.
 */
import type { CommandContext, CommandResult, ShellCommand } from './types';
import { atPath } from './types';
import { inputText } from './types';
import { gzip as pakoGzip, ungzip as pakoUngzip } from 'pako';

/** The file system as the context hands it to a command. */
type Fs = CommandContext['fs'];

/* ------------------------------------------------------------------ results */

/** A result with no output and no failure. */
function ok(stdout = ''): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}

/** A failure: the message goes to standard error with the given exit code. */
function fail(stderr: string, exitCode = 1): CommandResult {
    return { stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode };
}

/** Output on both streams. Exit code 2 marks a usage or unsupported-feature failure, 1 an I/O one. */
function finish(stdout: string, stderr: string, exitCode: number): CommandResult {
    return { stdout, stderr: stderr === '' || stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode };
}

/** The text of an exception, for the messages that carry one. */
function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------- paths */

/** Collapses `//`, `.` and `..` in an absolute path. `..` at the root stays at the root. */
function clean(path: string): string {
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

/** Joins a parent and one entry name. */
function joinPath(base: string, name: string): string {
    return base === '/' ? '/' + name : base + '/' + name;
}

/** The parent of a path; the parent of `/a` is `/`. */
function parentOf(path: string): string {
    const at = path.lastIndexOf('/');
    return at <= 0 ? '/' : path.slice(0, at);
}

/** The last component of a path. */
function baseName(path: string): string {
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
    const at = trimmed.lastIndexOf('/');
    return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/** Path glob matching: `*`, `?`, `[abc]`, `[!abc]` and `[a-z]`, and no directory separators. */
function fnmatch(pattern: string, name: string): boolean {
    let p = 0;
    let n = 0;
    let starP = -1;
    let starN = -1;
    while (n < name.length) {
        if (p < pattern.length && pattern[p] === '[') {
            let end = p + 1;
            if (end < pattern.length && (pattern[end] === '!' || pattern[end] === '^')) end++;
            if (end < pattern.length && pattern[end] === ']') end++;
            while (end < pattern.length && pattern[end] !== ']') end++;
            if (end >= pattern.length) {
                if (pattern[p] !== name[n]) return false;
                p++;
                n++;
                continue;
            }
            const body = pattern.slice(p + 1, end);
            const negate = body.startsWith('!') || body.startsWith('^');
            let hit = false;
            for (let i = negate ? 1 : 0; i < body.length; i++) {
                if (i + 2 < body.length && body[i + 1] === '-') {
                    if (name[n] >= body[i] && name[n] <= body[i + 2]) hit = true;
                    i += 2;
                    continue;
                }
                if (body[i] === name[n]) hit = true;
            }
            if (negate) hit = !hit;
            if (!hit) {
                if (starP < 0) return false;
                p = starP + 1;
                n = ++starN;
                continue;
            }
            p = end + 1;
            n++;
            continue;
        }
        if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
            p++;
            n++;
            continue;
        }
        if (p < pattern.length && pattern[p] === '*') {
            starP = p++;
            starN = n;
            continue;
        }
        if (starP >= 0) {
            p = starP + 1;
            n = ++starN;
            continue;
        }
        return false;
    }
    while (p < pattern.length && pattern[p] === '*') p++;
    return p === pattern.length;
}

/* --------------------------------------------------------- binary on the wire */

/** Where a raw byte 0x80..0xff is parked so that text -> bytes -> text is the identity. */
const HIGH_BYTE_ORIGIN = 0xf700;

/** Whether a byte is a UTF-8 continuation byte. */
function isContinuation(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}

/** The text carrying a byte string. Well-formed UTF-8 stays UTF-8; anything else is parked above. */
function bytesToText(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 0x80) {
            out += String.fromCharCode(b);
            continue;
        }
        if (b >= 0xc2 && b <= 0xdf && i + 1 < bytes.length && isContinuation(bytes[i + 1])) {
            out += String.fromCodePoint(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
            i += 1;
            continue;
        }
        if (b >= 0xe0 && b <= 0xef && i + 2 < bytes.length && isContinuation(bytes[i + 1]) && isContinuation(bytes[i + 2])) {
            const point = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
            /* Overlong encodings and surrogates are not well-formed, so they stay raw bytes. */
            if (point >= 0x800 && (point < 0xd800 || point > 0xdfff)) {
                out += String.fromCodePoint(point);
                i += 2;
                continue;
            }
        }
        if (b >= 0xf0 && b <= 0xf4 && i + 3 < bytes.length && isContinuation(bytes[i + 1]) && isContinuation(bytes[i + 2]) && isContinuation(bytes[i + 3])) {
            const point = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
            if (point >= 0x10000 && point <= 0x10ffff) {
                out += String.fromCodePoint(point);
                i += 3;
                continue;
            }
        }
        out += String.fromCharCode(HIGH_BYTE_ORIGIN + b);
    }
    return out;
}

/** The byte string a text carried. The exact inverse of `bytesToText`. */
function textToBytes(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const point = text.codePointAt(i) as number;
        if (point > 0xffff) i++;
        if (point < 0x80) {
            out.push(point);
            continue;
        }
        if (point >= HIGH_BYTE_ORIGIN && point <= HIGH_BYTE_ORIGIN + 0xff) {
            out.push(point - HIGH_BYTE_ORIGIN);
            continue;
        }
        if (point < 0x800) {
            out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
            continue;
        }
        if (point < 0x10000) {
            out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
            continue;
        }
        out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return new Uint8Array(out);
}

/** Casts the file system to the optional methods a richer implementation may carry. */
function extended(fs: Fs): Record<string, unknown> {
    return fs as unknown as Record<string, unknown>;
}

/** The bytes of a file, or undefined when there is no such file. */
function readBinary(fs: Fs, path: string): Uint8Array | undefined {
    const bytes = rawBytes(fs, path);
    if (bytes === undefined) return undefined;
    const text = textOf(fs, path);
    // A shell `>` or `>>` writes a command's output through the *text* writer, so a binary stream
    // parked in the file is its UTF-8 encoding, not the bytes themselves: `gzip -c a.txt > a.gz`
    // stored 61 bytes where the stream is 43. `bytesToText` is the identity on well-formed UTF-8
    // and parks every other byte, so it reproduces the text reading exactly when, and only when,
    // the file holds encoded text -- in which case `textToBytes` is the exact inverse and recovers
    // the stream. When it does not, the file holds raw bytes and those are the answer.
    if (text !== undefined && bytesToText(bytes) === text) return textToBytes(text);
    return bytes;
}

/** The bytes a file holds, through whichever byte-typed reader the file system offers. */
function rawBytes(fs: Fs, path: string): Uint8Array | undefined {
    try {
        const bytes = fs.readBytes(path);
        if (bytes !== undefined) return bytes;
    } catch {
        /* the file system may not implement readBytes; fall through */
    }
    const buffer = extended(fs).readBuffer;
    if (typeof buffer === 'function') {
        try {
            const raw = (buffer as (p: string) => ArrayBufferView | undefined).call(fs, path);
            if (raw) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        } catch {
            /* fall through */
        }
    }
    const text = fs.readFile(path);
    return text === undefined ? undefined : textToBytes(text);
}

/** The text a file holds, or undefined when it cannot be read as text. */
function textOf(fs: Fs, path: string): string | undefined {
    try {
        return fs.readFile(path);
    } catch {
        return undefined;
    }
}

/** Writes bytes to a file, preferring the byte-typed writers over the text-typed one. */
function writeBinary(fs: Fs, path: string, bytes: Uint8Array): void {
    try {
        fs.writeBytes(path, bytes);
        return;
    } catch {
        /* the file system may not implement writeBytes; fall through */
    }
    const buffer = extended(fs).writeBuffer;
    if (typeof buffer === 'function') {
        try {
            (buffer as (p: string, b: Uint8Array) => void).call(fs, path, bytes);
            return;
        } catch {
            /* fall through */
        }
    }
    fs.writeFile(path, bytesToText(bytes));
}

/** What `statPath` reports, defaulting to "nothing there". */
function kindOf(fs: Fs, path: string): 'file' | 'dir' | undefined {
    try {
        return fs.statPath(path)?.type;
    } catch {
        return undefined;
    }
}

/** Whether a directory exists. */
function hasDir(fs: Fs, path: string): boolean {
    try {
        return fs.isDirectory(path);
    } catch {
        return false;
    }
}

/** Creates a directory and every parent above it that is missing. */
function ensureDir(fs: Fs, path: string): void {
    if (path === '' || path === '/') return;
    if (hasDir(fs, path)) return;
    const parent = parentOf(path);
    if (parent !== path) ensureDir(fs, parent);
    try {
        fs.createDirectory(path);
    } catch {
        /* another agent raced us, or the path exists as a file; the caller reports that */
    }
}

/** The entries of a directory, or undefined when it is not one. */
function childrenOf(fs: Fs, path: string): string[] | undefined {
    try {
        const names = fs.readdirNames(path);
        if (names) return names.slice();
    } catch {
        /* fall through to listDirectory */
    }
    try {
        return fs.listDirectory(path).map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry));
    } catch {
        return undefined;
    }
}

/** Every file and directory under a root, parents before children. */
function walkTree(fs: Fs, root: string): { path: string; kind: 'file' | 'dir' }[] {
    const out: { path: string; kind: 'file' | 'dir' }[] = [];
    const kind = kindOf(fs, root);
    if (kind === undefined) return out;
    out.push({ path: root, kind });
    if (kind !== 'dir') return out;
    const names = childrenOf(fs, root) ?? [];
    const sorted = names.slice().sort();
    for (const name of sorted) {
        if (name === '.' || name === '..') continue;
        out.push(...walkTree(fs, joinPath(root, name)));
    }
    return out;
}

/* ----------------------------------------------------------------- gz codecs */

/** Compresses with DEFLATE in a gzip wrapper. Level 6 is what the host `gzip` defaults to. */
function gzipBytes(bytes: Uint8Array, level: number): Uint8Array {
    return pakoGzip(bytes, { level: level as -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
}

/** Decompresses a gzip stream, including the concatenated members `cat a.gz b.gz` produces. */
function gunzipBytes(bytes: Uint8Array): Uint8Array {
    return pakoUngzip(bytes);
}

/** Whether a byte string starts with the gzip magic. */
function isGzip(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** The uncompressed size gzip records in the last four bytes of a member. */
function gzipIsize(bytes: Uint8Array): number {
    if (bytes.length < 4) return 0;
    const at = bytes.length - 4;
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/* ------------------------------------------------------- unsupported codecs */

/** The one message an unavailable codec produces, so callers can match on it. */
function noCodec(command: string, format: string): CommandResult {
    return fail(
        `${command}: unsupported: no ${format} codec is available in this build ` +
            '(fflate 0.8.2, pako 2.1.0 and jszip 3.10.1 provide DEFLATE, gzip and zlib only)',
        2,
    );
}

/** The handler for every command whose format has no codec among the container's dependencies. */
function unsupported(command: string, format: string): ShellCommand {
    return () => noCodec(command, format);
}

/* ------------------------------------------------------------ option parsing */

/** Splits `--name=value` into its two halves. */
function splitLong(arg: string): { name: string; value: string | undefined } {
    const at = arg.indexOf('=');
    return at < 0 ? { name: arg, value: undefined } : { name: arg.slice(0, at), value: arg.slice(at + 1) };
}

/** Takes one value for a long option: the `=` half, or the next word. */
function takeValue(
    args: string[],
    index: number,
    inline: string | undefined,
): { value: string | undefined; next: number } {
    return inline === undefined ? { value: args[index + 1], next: index + 2 } : { value: inline, next: index + 1 };
}

/* --------------------------------------------------------------------- gzip */

interface GzipFlags {
    decompress: boolean;
    toStdout: boolean;
    keep: boolean;
    force: boolean;
    list: boolean;
    test: boolean;
    verbose: boolean;
    quiet: boolean;
    recursive: boolean;
    noName: boolean;
    level: number;
    suffix: string;
    files: string[];
}

/** The flags gzip, gunzip and zcat accept. */
function parseGzipFlags(args: string[], defaultSuffix: string, decompress: boolean): GzipFlags | string {
    const flags: GzipFlags = {
        decompress,
        toStdout: false,
        keep: false,
        force: false,
        list: false,
        test: false,
        verbose: false,
        quiet: false,
        recursive: false,
        noName: false,
        level: 6,
        suffix: defaultSuffix,
        files: [],
    };
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--') {
            for (index += 1; index < args.length; index++) flags.files.push(args[index]);
            break;
        }
        if (arg.startsWith('--')) {
            const { name, value } = splitLong(arg);
            switch (name) {
                case '--stdout':
                case '--to-stdout':
                    flags.toStdout = true;
                    index += 1;
                    break;
                case '--decompress':
                case '--uncompress':
                    flags.decompress = true;
                    index += 1;
                    break;
                case '--keep':
                    flags.keep = true;
                    index += 1;
                    break;
                case '--force':
                    flags.force = true;
                    index += 1;
                    break;
                case '--list':
                    flags.list = true;
                    index += 1;
                    break;
                case '--test':
                    flags.test = true;
                    index += 1;
                    break;
                case '--verbose':
                    flags.verbose = true;
                    index += 1;
                    break;
                case '--quiet':
                    flags.quiet = true;
                    index += 1;
                    break;
                case '--recursive':
                    flags.recursive = true;
                    index += 1;
                    break;
                case '--no-name':
                    flags.noName = true;
                    index += 1;
                    break;
                case '--fast':
                    flags.level = 1;
                    index += 1;
                    break;
                case '--best':
                    flags.level = 9;
                    index += 1;
                    break;
                case '--suffix': {
                    const taken = takeValue(args, index, value);
                    if (taken.value === undefined) return 'option --suffix requires a value';
                    flags.suffix = taken.value;
                    index = taken.next;
                    break;
                }
                default:
                    return `invalid option -- '${name}'`;
            }
            continue;
        }
        if (arg.length > 1 && arg[0] === '-') {
            for (let at = 1; at < arg.length; at++) {
                const letter = arg[at];
                if (letter >= '1' && letter <= '9') {
                    flags.level = Number(letter);
                    continue;
                }
                switch (letter) {
                    case 'c':
                        flags.toStdout = true;
                        break;
                    case 'd':
                        flags.decompress = true;
                        break;
                    case 'k':
                        flags.keep = true;
                        break;
                    case 'f':
                        flags.force = true;
                        break;
                    case 'l':
                        flags.list = true;
                        break;
                    case 't':
                        flags.test = true;
                        break;
                    case 'v':
                        flags.verbose = true;
                        break;
                    case 'q':
                        flags.quiet = true;
                        break;
                    case 'r':
                        flags.recursive = true;
                        break;
                    case 'n':
                        flags.noName = true;
                        break;
                    case 'N':
                        flags.noName = false;
                        break;
                    case 'h':
                    case 'V':
                        flags.verbose = true;
                        break;
                    case 'S': {
                        const inline = at + 1 < arg.length ? arg.slice(at + 1) : undefined;
                        if (inline !== undefined) {
                            flags.suffix = inline;
                            at = arg.length;
                            break;
                        }
                        const nextWord = args[index + 1];
                        if (nextWord === undefined) return 'option -S requires a value';
                        flags.suffix = nextWord;
                        index += 1;
                        break;
                    }
                    default:
                        return `invalid option -- '${letter}'`;
                }
            }
            index += 1;
            continue;
        }
        flags.files.push(arg);
        index += 1;
    }
    return flags;
}

/** The compression ratio gzip prints, as a percentage with one decimal. */
function ratioText(compressed: number, uncompressed: number): string {
    if (uncompressed === 0) return '0.0%';
    const ratio = (1 - compressed / uncompressed) * 100;
    return `${ratio.toFixed(1)}%`;
}

/** Reads one operand: `-` and an absent operand both mean standard input. */
function operandBytes(ctx: CommandContext, files: string[], index: number): Uint8Array | undefined {
    const name = files[index];
    if (name === undefined || name === '-') return textToBytes(ctx.input ?? '');
    return readBinary(ctx.fs, atPath(ctx, name));
}

/** Expands `-r` operands: a directory becomes the files beneath it. */
function expandOperands(ctx: CommandContext, files: string[], recursive: boolean): string[] {
    if (!recursive) return files;
    const out: string[] = [];
    for (const file of files) {
        if (file === '-') {
            out.push(file);
            continue;
        }
        const path = atPath(ctx, file);
        if (kindOf(ctx.fs, path) === 'dir') {
            for (const entry of walkTree(ctx.fs, path)) {
                if (entry.kind === 'file') out.push(entry.path);
            }
            continue;
        }
        out.push(file);
    }
    return out;
}

/** The gzip, gunzip and zcat body. */
function runGzip(ctx: CommandContext, name: string, args: string[], suffix: string, decompress: boolean): CommandResult {
    const parsed = parseGzipFlags(args, suffix, decompress);
    if (typeof parsed === 'string') return fail(`${name}: ${parsed}`, 2);
    const flags = parsed;

    if (flags.list) return gzipList(ctx, name, flags);
    const files = expandOperands(ctx, flags.files, flags.recursive);

    const chunks: string[] = [];
    const errors: string[] = [];
    let worst = 0;

    for (const file of files) {
        if (file === '-') {
            const source = textToBytes(ctx.input ?? '');
            if (flags.decompress) {
                const plain = decompressBytes(source, name, file, errors);
                if (plain === undefined) {
                    worst = 1;
                    continue;
                }
                chunks.push(bytesToText(plain));
                continue;
            }
            chunks.push(bytesToText(gzipBytes(source, flags.level)));
            continue;
        }
        const path = atPath(ctx, file);
        const source = readBinary(ctx.fs, path);
        if (source === undefined) {
            errors.push(`${name}: ${file}: No such file or directory`);
            worst = 1;
            continue;
        }
        if (flags.test) {
            const plain = decompressBytes(source, name, file, errors);
            if (plain === undefined) {
                worst = 1;
                continue;
            }
            if (flags.verbose) chunks.push(`${name}: ${file}: OK\n`);
            continue;
        }
        if (flags.decompress) {
            const plain = decompressBytes(source, name, file, errors);
            if (plain === undefined) {
                worst = 1;
                continue;
            }
            const target = decompressedName(ctx, file, flags.suffix);
            if (target === undefined) {
                errors.push(`${name}: ${file}: unknown suffix -- ignored`);
                worst = 1;
                continue;
            }
            if (!emit(ctx, name, flags, chunks, errors, target, plain, file, source.length, false)) worst = 1;
            continue;
        }
        if (file.endsWith(flags.suffix)) {
            errors.push(`${name}: ${file} already has ${flags.suffix} suffix -- unchanged`);
            worst = 1;
            continue;
        }
        const target = file + flags.suffix;
        if (!emit(ctx, name, flags, chunks, errors, target, gzipBytes(source, flags.level), file, source.length, true)) worst = 1;
    }

    if (files.length === 0) {
        const source = textToBytes(ctx.input ?? '');
        if (flags.decompress) {
            const plain = decompressBytes(source, name, '-', errors);
            if (plain === undefined) return finish(chunks.join(''), errors.join('\n'), 1);
            chunks.push(bytesToText(plain));
        } else {
            chunks.push(bytesToText(gzipBytes(source, flags.level)));
        }
    }

    if (errors.length > 0 && worst === 0) worst = 1;
    return finish(chunks.join(''), errors.join('\n'), worst);
}

/** Decompresses, reporting a failure the way gzip does. */
function decompressBytes(source: Uint8Array, name: string, file: string, errors: string[]): Uint8Array | undefined {
    if (!isGzip(source)) {
        errors.push(`${name}: ${file}: not in gzip format`);
        return undefined;
    }
    try {
        return gunzipBytes(source);
    } catch (error) {
        errors.push(`${name}: ${file}: ${reason(error)}`);
        return undefined;
    }
}

/** Where a decompressed operand goes: the name without its suffix. */
function decompressedName(ctx: CommandContext, file: string, suffix: string): string | undefined {
    const path = atPath(ctx, file);
    if (file.endsWith(suffix)) return file.slice(0, file.length - suffix.length);
    if (suffix !== '.gz' && file.endsWith('.gz')) return file.slice(0, file.length - 3);
    if (kindOf(ctx.fs, path + suffix) !== undefined) return file;
    if (suffix !== '.gz' && kindOf(ctx.fs, path + '.gz') !== undefined) return file;
    return undefined;
}

/**
 * Writes one transformed operand, to standard output or to a file, and removes the original the way
 * gzip does unless it was asked to keep it. `otherSize` is the size of the operand before the
 * transform, which is what the verbose line needs for its ratio.
 */
function emit(
    ctx: CommandContext,
    name: string,
    flags: GzipFlags,
    chunks: string[],
    errors: string[],
    target: string,
    bytes: Uint8Array,
    source: string,
    otherSize: number,
    compressed: boolean,
): boolean {
    if (flags.test) return true;
    if (flags.toStdout) {
        chunks.push(bytesToText(bytes));
        return true;
    }
    const path = atPath(ctx, target);
    if (kindOf(ctx.fs, path) !== undefined && !flags.force) {
        errors.push(`${name}: ${target} already exists; not overwritten`);
        return false;
    }
    try {
        ensureDir(ctx.fs, parentOf(path));
        writeBinary(ctx.fs, path, bytes);
    } catch (error) {
        errors.push(`${name}: ${target}: ${reason(error)}`);
        return false;
    }
    if (!flags.keep) {
        try {
            ctx.fs.removePath(atPath(ctx, source), false);
        } catch {
            /* the source is gone, or the file system will not remove it; the output stands */
        }
    }
    if (flags.verbose) {
        const plain = compressed ? otherSize : bytes.length;
        const packed = compressed ? bytes.length : otherSize;
        chunks.push(`${source}:\t${ratioText(packed, plain)} -- replaced with ${target}\n`);
    }
    return true;
}

/* -------------------------------------------------------------- gzip -l */

/** The `gzip -l` table. */
function gzipList(ctx: CommandContext, name: string, flags: GzipFlags): CommandResult {
    const rows: string[] = [];
    const errors: string[] = [];
    let worst = 0;
    if (flags.verbose) {
        rows.push('method  crc     date  time    compressed uncompressed  ratio uncompressed_name');
    } else {
        rows.push('  compressed uncompressed  ratio uncompressed_name');
    }
    let totalPacked = 0;
    let totalPlain = 0;
    const files = flags.files.length > 0 ? flags.files : ['-'];
    for (const file of files) {
        const source = file === '-' ? textToBytes(ctx.input ?? '') : readBinary(ctx.fs, atPath(ctx, file));
        if (source === undefined) {
            errors.push(`${name}: ${file}: No such file or directory`);
            worst = 1;
            continue;
        }
        if (!isGzip(source)) {
            errors.push(`${name}: ${file}: not in gzip format`);
            worst = 1;
            continue;
        }
        let plain = 0;
        try {
            plain = gunzipBytes(source).length;
        } catch (error) {
            errors.push(`${name}: ${file}: ${reason(error)}`);
            worst = 1;
            continue;
        }
        const recorded = gzipIsize(source);
        if (recorded !== 0) plain = recorded;
        const packed = source.length;
        totalPacked += packed;
        totalPlain += plain;
        const label = file.endsWith(flags.suffix) ? file.slice(0, file.length - flags.suffix.length) : file;
        if (flags.verbose) {
            const crc = source.length >= 8 ? (source[source.length - 8] | (source[source.length - 7] << 8) | (source[source.length - 6] << 16) | (source[source.length - 5] << 24)) >>> 0 : 0;
            const stamp = source.length >= 8 ? (source[4] | (source[5] << 8) | (source[6] << 16) | (source[7] << 24)) >>> 0 : 0;
            const when = new Date(stamp * 1000);
            rows.push(
                `defla ${crc.toString(16).padStart(8, '0')} ${monthName(when.getMonth())} ${String(when.getDate()).padStart(2, ' ')} ` +
                    `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} ` +
                    `${String(packed).padStart(11)} ${String(plain).padStart(12)}  ${ratioText(packed, plain).padStart(5)} ${label}`,
            );
        } else {
            rows.push(`${String(packed).padStart(11)} ${String(plain).padStart(12)}  ${ratioText(packed, plain).padStart(5)} ${label}`);
        }
    }
    if (files.length > 1) {
        rows.push(`${String(totalPacked).padStart(11)} ${String(totalPlain).padStart(12)}  ${ratioText(totalPacked, totalPlain).padStart(5)} (totals)`);
    }
    return finish(rows.join('\n') + '\n', errors.join('\n'), worst);
}

/** The three-letter month gzip and tar print. */
function monthName(month: number): string {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month] ?? 'Jan';
}

/* ------------------------------------------------------------- LZW (compress) */

/** The two magic bytes every compress stream starts with. */
const LZW_MAGIC_A = 0x1f;
const LZW_MAGIC_B = 0x9d;

/**
 * LZW as the host `compress` writes it, measured byte for byte against /usr/bin/compress: 9-to-
 * `maxBits` bit codes packed least significant bit first, the first string code at 257 once the 256
 * literals are used up, no clear code up front and no end-of-information code at the end -- the
 * stream simply stops, and the flush leaves fewer than eight padding bits, too few to be misread as
 * another code. The width grows one code later than the textbook rule (when the next free code
 * passes `1 << width`, not `(1 << width) - 1`), and when the table is full the encoder stops adding
 * to it rather than clearing it: both were measured, and getting either wrong costs bytes or, for
 * the clear, produces a stream the host itself will not read back.
 */
function lzwEncode(bytes: Uint8Array, maxBits: number, block: boolean): Uint8Array {
    const out: number[] = [];
    let bitBuffer = 0;
    let bitCount = 0;
    const put = (code: number, bits: number): void => {
        bitBuffer |= code << bitCount;
        bitCount += bits;
        while (bitCount >= 8) {
            out.push(bitBuffer & 0xff);
            bitBuffer >>>= 8;
            bitCount -= 8;
        }
    };
    const maxMax = 1 << maxBits;
    const firstFree = block ? 257 : 256;
    let table = new Map<number, number>();
    let next = firstFree;
    let width = 9;
    if (bytes.length === 0) {
        if (bitCount > 0) out.push(bitBuffer & 0xff);
        return new Uint8Array(out);
    }
    let current = bytes[0];
    for (let index = 1; index < bytes.length; index++) {
        const byte = bytes[index];
        const key = current * 256 + byte;
        const known = table.get(key);
        if (known !== undefined) {
            current = known;
            continue;
        }
        put(current, width);
        if (next < maxMax) {
            table.set(key, next);
            next += 1;
            if (next > 1 << width && width < maxBits) width += 1;
        }
        current = byte;
    }
    put(current, width);
    if (bitCount > 0) out.push(bitBuffer & 0xff);
    return new Uint8Array(out);
}

/** The inverse of `lzwEncode`, returning undefined on a stream that does not decode. */
function lzwDecode(bytes: Uint8Array, maxBits: number, block: boolean): Uint8Array | undefined {
    const maxMax = 1 << maxBits;
    const clearCode = block ? 256 : -1;
    const firstFree = block ? 257 : 256;
    const prefix = new Int32Array(maxMax);
    const suffix = new Uint8Array(maxMax);
    const out: number[] = [];
    let position = 0;
    const take = (bits: number): number => {
        if (position + bits > bytes.length * 8) return -1;
        let value = 0;
        for (let index = 0; index < bits; index++) {
            const at = position + index;
            value |= ((bytes[at >> 3] >> (at & 7)) & 1) << index;
        }
        position += bits;
        return value;
    };
    let width = 9;
    let next = firstFree;
    let oldCode = -1;
    let finalChar = 0;
    for (;;) {
        let code = take(width);
        if (code < 0) break;
        if (block && code === clearCode) {
            width = 9;
            next = firstFree;
            oldCode = -1;
            continue;
        }
        const inCode = code;
        const stack: number[] = [];
        let walk = code;
        if (code >= next) {
            if (oldCode < 0) return undefined;
            stack.push(finalChar);
            walk = oldCode;
        }
        while (walk >= 256) {
            if (walk >= next) return undefined;
            stack.push(suffix[walk]);
            walk = prefix[walk];
        }
        finalChar = walk;
        stack.push(walk);
        for (let index = stack.length - 1; index >= 0; index--) out.push(stack[index]);
        if (oldCode >= 0 && next < maxMax) {
            prefix[next] = oldCode;
            suffix[next] = finalChar;
            next += 1;
            /* One code earlier than the encoder grows its width: the code about to be read may be
             * the entry just added, and that is the asymmetry `compress` is known for. */
            if (next >= 1 << width && width < maxBits) width += 1;
        }
        oldCode = inCode;
    }
    return new Uint8Array(out);
}

/** The three bytes a .Z file starts with: the magic and the block-mode/maximum-width byte. */
function lzwHeader(maxBits: number, block: boolean): Uint8Array {
    return new Uint8Array([LZW_MAGIC_A, LZW_MAGIC_B, block ? 0x80 | maxBits : maxBits]);
}

/* ------------------------------------------------------------- compress */

interface CompressFlags {
    decompress: boolean;
    toStdout: boolean;
    force: boolean;
    verbose: boolean;
    keep: boolean;
    bits: number;
    files: string[];
}

/** The flags `compress` and `uncompress` accept. */
function parseCompressFlags(args: string[], decompress: boolean): CompressFlags | string {
    const flags: CompressFlags = {
        decompress,
        toStdout: false,
        force: false,
        verbose: false,
        keep: false,
        bits: 16,
        files: [],
    };
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--') {
            for (index += 1; index < args.length; index++) flags.files.push(args[index]);
            break;
        }
        if (arg.startsWith('--')) {
            const { name, value } = splitLong(arg);
            if (name === '--stdout' || name === '--to-stdout') flags.toStdout = true;
            else if (name === '--decompress' || name === '--uncompress') flags.decompress = true;
            else if (name === '--force') flags.force = true;
            else if (name === '--verbose') flags.verbose = true;
            else if (name === '--keep') flags.keep = true;
            else if (name === '--bits') {
                const taken = takeValue(args, index, value);
                if (taken.value === undefined) return 'option --bits requires a value';
                const parsed = Number(taken.value);
                if (!Number.isFinite(parsed) || parsed < 9 || parsed > 16) return `invalid maximum code width: ${taken.value}`;
                flags.bits = parsed;
                index = taken.next;
                continue;
            } else return `invalid option -- '${name}'`;
            index += 1;
            continue;
        }
        if (arg.length > 1 && arg[0] === '-') {
            for (let at = 1; at < arg.length; at++) {
                const letter = arg[at];
                if (letter === 'c') flags.toStdout = true;
                else if (letter === 'd') flags.decompress = true;
                else if (letter === 'f') flags.force = true;
                else if (letter === 'v') flags.verbose = true;
                else if (letter === 'k') flags.keep = true;
                else if (letter === 'b') {
                    const inline = at + 1 < arg.length ? arg.slice(at + 1) : undefined;
                    const word = inline !== undefined ? inline : args[index + 1];
                    if (word === undefined) return 'option -b requires a value';
                    const parsed = Number(word);
                    if (!Number.isFinite(parsed) || parsed < 9 || parsed > 16) return `invalid maximum code width: ${word}`;
                    flags.bits = parsed;
                    if (inline === undefined) index += 1;
                    at = arg.length;
                } else return `invalid option -- '${letter}'`;
            }
            index += 1;
            continue;
        }
        flags.files.push(arg);
        index += 1;
    }
    return flags;
}

/** The `compress` and `uncompress` body. */
function runCompress(ctx: CommandContext, name: string, args: string[], decompress: boolean): CommandResult {
    const parsed = parseCompressFlags(args, decompress);
    if (typeof parsed === 'string') return fail(`${name}: ${parsed}`, 2);
    const flags = parsed;
    const suffix = '.Z';
    const chunks: string[] = [];
    const errors: string[] = [];
    let worst = 0;
    const files = flags.files.length > 0 ? flags.files : ['-'];

    for (const file of files) {
        const source = file === '-' ? textToBytes(ctx.input ?? '') : readBinary(ctx.fs, atPath(ctx, file));
        if (source === undefined) {
            errors.push(`${name}: ${file}: No such file or directory`);
            worst = 1;
            continue;
        }
        let bytes: Uint8Array;
        if (flags.decompress) {
            if (source.length < 3 || source[0] !== LZW_MAGIC_A || source[1] !== LZW_MAGIC_B) {
                errors.push(`${name}: ${file}: not in compressed format`);
                worst = 1;
                continue;
            }
            const control = source[2];
            const block = (control & 0x80) !== 0;
            const maxBits = (control & 0x1f) || 16;
            const plain = lzwDecode(source.subarray(3), maxBits, block);
            if (plain === undefined) {
                errors.push(`${name}: ${file}: corrupted compressed data`);
                worst = 1;
                continue;
            }
            bytes = plain;
        } else {
            const packed = lzwEncode(source, flags.bits, true);
            const framed = new Uint8Array(3 + packed.length);
            framed.set(lzwHeader(flags.bits, true), 0);
            framed.set(packed, 3);
            bytes = framed;
        }
        if (flags.toStdout) {
            chunks.push(bytesToText(bytes));
            continue;
        }
        let target: string;
        if (flags.decompress) {
            if (!file.endsWith(suffix)) {
                errors.push(`${name}: ${file}: unknown suffix -- ignored`);
                worst = 1;
                continue;
            }
            target = file.slice(0, file.length - suffix.length);
        } else {
            if (file.endsWith(suffix)) {
                errors.push(`${name}: ${file} already has ${suffix} suffix -- unchanged`);
                worst = 1;
                continue;
            }
            target = file + suffix;
        }
        const path = atPath(ctx, target);
        if (kindOf(ctx.fs, path) !== undefined && !flags.force) {
            errors.push(`${name}: ${target} already exists; not overwritten`);
            worst = 1;
            continue;
        }
        try {
            ensureDir(ctx.fs, parentOf(path));
            writeBinary(ctx.fs, path, bytes);
        } catch (error) {
            errors.push(`${name}: ${target}: ${reason(error)}`);
            worst = 1;
            continue;
        }
        if (!flags.keep && file !== '-') {
            try {
                ctx.fs.removePath(atPath(ctx, file), false);
            } catch {
                /* the original is gone; the output stands */
            }
        }
        if (flags.verbose) {
            chunks.push(`${file}:\t${ratioText(flags.decompress ? source.length : bytes.length, flags.decompress ? bytes.length : source.length)} -- replaced with ${target}\n`);
        }
    }

    return finish(chunks.join(''), errors.join('\n'), worst);
}

/* ---------------------------------------------------------------------- tar */

/** One member of a tar archive. `data` is null for the types that carry no payload. */
interface TarMember {
    name: string;
    mode: number;
    uid: number;
    gid: number;
    size: number;
    mtime: number;
    type: string;
    linkname: string;
    uname: string;
    gname: string;
    prefix: string;
    data: Uint8Array | null;
}

/** The bytes of a tar header field, up to the first NUL. */
function tarText(block: Uint8Array, start: number, length: number): string {
    let end = start + length;
    for (let at = start; at < start + length; at++) {
        if (block[at] === 0) {
            end = at;
            break;
        }
    }
    return bytesToText(block.subarray(start, end));
}

/** A tar numeric field: octal digits, or base-256 when the first byte has its high bit set. */
function tarNumber(block: Uint8Array, start: number, length: number): number {
    if ((block[start] & 0x80) !== 0) {
        let value = block[start] & 0x7f;
        for (let at = start + 1; at < start + length; at++) value = value * 256 + block[at];
        return value;
    }
    let text = '';
    for (let at = start; at < start + length; at++) {
        const byte = block[at];
        if (byte === 0 || byte === 0x20) {
            if (text === '') continue;
            break;
        }
        text += String.fromCharCode(byte);
    }
    const parsed = Number.parseInt(text, 8);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** The unsigned sum of a header's bytes with the checksum field read as spaces. */
function tarChecksum(block: Uint8Array): number {
    let sum = 0;
    for (let at = 0; at < 512; at++) sum += at >= 148 && at < 156 ? 32 : block[at];
    return sum;
}

/** Writes a text field, NUL padded. */
function putText(block: Uint8Array, start: number, length: number, text: string): void {
    const bytes = textToBytes(text);
    for (let at = 0; at < length; at++) block[start + at] = at < bytes.length ? bytes[at] : 0;
}

/** Writes a numeric field as octal digits, falling back to base-256 for values that do not fit. */
function putNumber(block: Uint8Array, start: number, length: number, value: number): void {
    const limit = Math.pow(8, length - 1) - 1;
    if (value >= 0 && value <= limit) {
        let text = value.toString(8).padStart(length - 1, '0');
        if (text.length > length - 1) text = text.slice(text.length - (length - 1));
        for (let at = 0; at < length - 1; at++) block[start + at] = text.charCodeAt(at);
        block[start + length - 1] = 0;
        return;
    }
    block[start] = 0x80;
    let rest = value;
    for (let at = length - 1; at >= 1; at--) {
        block[start + at] = rest & 0xff;
        rest = Math.floor(rest / 256);
    }
}

/** Builds one 512-byte ustar header. */
function tarHeader(member: TarMember): Uint8Array {
    const block = new Uint8Array(512);
    putText(block, 0, 100, member.name);
    putNumber(block, 100, 8, member.mode & 0o7777);
    putNumber(block, 108, 8, member.uid);
    putNumber(block, 116, 8, member.gid);
    putNumber(block, 124, 12, member.size);
    putNumber(block, 136, 12, member.mtime);
    for (let at = 148; at < 156; at++) block[at] = 0x20;
    block[156] = member.type.charCodeAt(0);
    putText(block, 157, 100, member.linkname);
    putText(block, 257, 6, 'ustar');
    block[263] = 0x30;
    block[264] = 0x30;
    putText(block, 265, 32, member.uname);
    putText(block, 297, 32, member.gname);
    putNumber(block, 329, 8, 0);
    putNumber(block, 337, 8, 0);
    putText(block, 345, 155, member.prefix);
    putNumber(block, 148, 8, tarChecksum(block));
    return block;
}

/** The pax records of an extended header block, as keyword to value. */
function paxRecords(data: Uint8Array): Record<string, string> {
    const text = bytesToText(data);
    const records: Record<string, string> = {};
    let at = 0;
    while (at < text.length) {
        let newline = text.indexOf('\n', at);
        if (newline < 0) newline = text.length;
        const line = text.slice(at, newline);
        at = newline + 1;
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const declared = Number.parseInt(line.slice(0, space), 10);
        const body = declared > 0 && declared <= line.length ? line.slice(space + 1, declared - 1) : line.slice(space + 1);
        const equals = body.indexOf('=');
        if (equals < 0) continue;
        records[body.slice(0, equals)] = body.slice(equals + 1);
    }
    return records;
}

/** Splits a name that is too long for the name field into a ustar prefix and name. */
function splitUstar(name: string): { prefix: string; name: string } | undefined {
    const bytes = textToBytes(name);
    if (bytes.length <= 100) return undefined;
    for (let at = 0; at < name.length; at++) {
        if (name[at] !== '/') continue;
        const tail = name.slice(at + 1);
        const head = name.slice(0, at);
        if (textToBytes(tail).length <= 100 && textToBytes(head).length <= 155) return { prefix: head, name: tail };
    }
    return undefined;
}

/** Reads a tar archive. GNU long names (`L`/`K`) and pax records (`x`/`g`) are both honoured. */
function parseTar(bytes: Uint8Array): { members: TarMember[]; error?: string } {
    const members: TarMember[] = [];
    let longName: string | null = null;
    let longLink: string | null = null;
    let pax: Record<string, string> | null = null;
    let offset = 0;
    let ended = false;
    while (offset + 512 <= bytes.length) {
        const block = bytes.subarray(offset, offset + 512);
        let blank = true;
        for (let at = 0; at < 512; at++) {
            if (block[at] !== 0) {
                blank = false;
                break;
            }
        }
        if (blank) {
            ended = true;
            break;
        }
        if (tarNumber(block, 148, 8) !== tarChecksum(block)) {
            return {
                members,
                error: members.length === 0 ? 'tar: Unrecognized archive format' : 'tar: Damaged archive',
            };
        }
        let name = tarText(block, 0, 100);
        const mode = tarNumber(block, 100, 8);
        const uid = tarNumber(block, 108, 8);
        const gid = tarNumber(block, 116, 8);
        let size = tarNumber(block, 124, 12);
        const mtime = tarNumber(block, 136, 12);
        const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156]);
        let linkname = tarText(block, 157, 100);
        const uname = tarText(block, 265, 32);
        const gname = tarText(block, 297, 32);
        const magic = tarText(block, 257, 6);
        const prefix = magic === 'ustar' ? tarText(block, 345, 155) : '';
        if (prefix.length > 0 && !name.startsWith('/')) name = prefix + '/' + name;

        const start = offset + 512;
        const end = start + Math.ceil(size / 512) * 512;
        if (end > bytes.length) {
            return { members, error: `tar: Unexpected EOF in archive (${name})` };
        }
        const data = bytes.subarray(start, start + size);
        offset = end;

        if (type === 'L') {
            longName = bytesToText(data.subarray(0, Math.max(0, data.length - 1)));
            continue;
        }
        if (type === 'K') {
            longLink = bytesToText(data.subarray(0, Math.max(0, data.length - 1)));
            continue;
        }
        if (type === 'x' || type === 'g' || type === 'X') {
            pax = { ...(pax ?? {}), ...paxRecords(data) };
            continue;
        }
        if (longName !== null) {
            name = longName;
            longName = null;
        }
        if (longLink !== null) {
            linkname = longLink;
            longLink = null;
        }
        if (pax !== null) {
            if (typeof pax.path === 'string') name = pax.path;
            if (typeof pax.linkpath === 'string') linkname = pax.linkpath;
            if (typeof pax.size === 'string') size = Number.parseInt(pax.size, 10) || size;
            if (type !== 'g') pax = null;
        }
        const payload = type === '1' || type === '2' || type === '5' || type === '3' || type === '4' || type === '6' ? null : data;
        members.push({
            name,
            mode,
            uid,
            gid,
            size: payload ? payload.length : 0,
            mtime,
            type,
            linkname,
            uname,
            gname,
            prefix: '',
            data: payload,
        });
    }
    if (!ended && offset < bytes.length) {
        return { members, error: 'tar: Truncated tar archive' };
    }
    return { members };
}

/** Serializes members into a tar archive: headers, payloads and the two zero blocks that end it. */
function buildTar(members: TarMember[]): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const member of members) {
        const stored: TarMember = { ...member };
        if (textToBytes(stored.name).length > 100) {
            const split = splitUstar(stored.name);
            if (split) {
                stored.prefix = split.prefix;
                stored.name = split.name;
            } else {
                const raw = textToBytes(stored.name);
                const padded = new Uint8Array(Math.ceil((raw.length + 1) / 512) * 512);
                padded.set(raw, 0);
                const tag: TarMember = {
                    name: '././@LongLink',
                    mode: 0,
                    uid: 0,
                    gid: 0,
                    size: raw.length + 1,
                    mtime: 0,
                    type: 'L',
                    linkname: '',
                    uname: '',
                    gname: '',
                    prefix: '',
                    data: padded,
                };
                parts.push(tarHeader(tag), padded);
                stored.name = bytesToText(raw.subarray(0, 100));
            }
        }
        parts.push(tarHeader(stored));
        if (stored.data && stored.data.length > 0) {
            const padded = new Uint8Array(Math.ceil(stored.data.length / 512) * 512);
            padded.set(stored.data, 0);
            parts.push(padded);
        }
    }
    parts.push(new Uint8Array(1024));
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** The `ls`-style mode string, with the setuid, setgid and sticky substitutions. */
function modeText(mode: number, kind: 'file' | 'dir' | 'link' | 'other'): string {
    const head = kind === 'dir' ? 'd' : kind === 'link' ? 'l' : '-';
    const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
    const letters = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
    let text = head;
    for (let at = 0; at < 9; at++) text += (mode & bits[at]) !== 0 ? letters[at] : '-';
    if ((mode & 0o4000) !== 0) text = text.slice(0, 3) + ((text[3] === 'x' ? 's' : 'S')) + text.slice(4);
    if ((mode & 0o2000) !== 0) text = text.slice(0, 6) + ((text[6] === 'x' ? 's' : 'S')) + text.slice(7);
    if ((mode & 0o1000) !== 0) text = text.slice(0, 9) + ((text[9] === 'x' ? 't' : 'T'));
    return text;
}

/** The date a tar or cpio listing prints: hour and minute inside six months, year outside it. */
function stampText(seconds: number): string {
    const when = new Date(seconds * 1000);
    const month = monthName(when.getMonth());
    const day = String(when.getDate()).padStart(2, ' ');
    const age = Date.now() / 1000 - seconds;
    if (age > 15552000 || age < -86400) return `${month} ${day} ${String(when.getFullYear()).padStart(5)}`;
    return `${month} ${day} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/** What a tar member is, from its type flag. */
function kindOfFlag(flag: string): 'file' | 'dir' | 'link' | 'hard' | 'other' {
    if (flag === '5') return 'dir';
    if (flag === '2') return 'link';
    if (flag === '1') return 'hard';
    if (flag === '0' || flag === '7' || flag === '\0') return 'file';
    return 'other';
}

/** The verbose listing line, in the host bsdtar's column order. */
function tarVerboseLine(member: TarMember): string {
    const kind = kindOfFlag(member.type);
    const mode = modeText(member.mode, kind === 'hard' ? 'file' : kind);
    const owner = member.uname !== '' ? member.uname : String(member.uid);
    const group = member.gname !== '' ? member.gname : String(member.gid);
    const line =
        `${mode} ${String(1).padStart(3)} ${owner} ${group} ` +
        `${String(member.size).padStart(9)} ${stampText(member.mtime)} ${member.name}`;
    return kind === 'link' ? `${line} -> ${member.linkname}` : line;
}

/* --------------------------------------------------------------- tar flags */

interface TarFlags {
    mode: 'create' | 'extract' | 'list' | undefined;
    archive: string | undefined;
    verbose: boolean;
    gzip: boolean;
    bzip2: boolean;
    xz: boolean;
    preserve: boolean;
    keepOld: boolean;
    noMtime: boolean;
    toStdout: boolean;
    directories: string[];
    excludes: string[];
    operands: string[];
}

/** The flags tar accepts, in both the dashed and the old undashed spelling. */
function parseTarFlags(args: string[]): TarFlags | string {
    const flags: TarFlags = {
        mode: undefined,
        archive: undefined,
        verbose: false,
        gzip: false,
        bzip2: false,
        xz: false,
        preserve: false,
        keepOld: false,
        noMtime: false,
        toStdout: false,
        directories: [],
        excludes: [],
        operands: [],
    };
    let index = 0;
    let first = true;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--') {
            for (index += 1; index < args.length; index++) flags.operands.push(args[index]);
            break;
        }
        const undashed = first && !arg.startsWith('-') && /^[a-zA-Z]+$/.test(arg);
        if (arg.startsWith('--')) {
            const { name, value } = splitLong(arg);
            if (name === '--create') flags.mode = 'create';
            else if (name === '--extract' || name === '--get') flags.mode = 'extract';
            else if (name === '--list') flags.mode = 'list';
            else if (name === '--verbose') flags.verbose = true;
            else if (name === '--gzip' || name === '--gunzip' || name === '--ungzip') flags.gzip = true;
            else if (name === '--bzip2' || name === '--bunzip2') flags.bzip2 = true;
            else if (name === '--xz') flags.xz = true;
            else if (name === '--preserve-permissions' || name === '--same-permissions') flags.preserve = true;
            else if (name === '--keep-old-files') flags.keepOld = true;
            else if (name === '--touch' || name === '--modification-time') flags.noMtime = true;
            else if (name === '--to-stdout') flags.toStdout = true;
            else if (name === '--file' || name === '--directory') {
                const taken = takeValue(args, index, value);
                if (taken.value === undefined) return `option ${name} requires a value`;
                if (name === '--file') flags.archive = taken.value;
                else flags.directories.push(taken.value);
                index = taken.next;
                continue;
            } else if (name === '--exclude') {
                const taken = takeValue(args, index, value);
                if (taken.value === undefined) return 'option --exclude requires a value';
                flags.excludes.push(taken.value);
                index = taken.next;
                continue;
            } else return `invalid option -- '${name}'`;
            index += 1;
            first = false;
            continue;
        }
        if (arg.startsWith('-') || undashed) {
            const letters = arg.startsWith('-') ? arg.slice(1) : arg;
            for (let at = 0; at < letters.length; at++) {
                const letter = letters[at];
                if (letter === 'f') {
                    const inline = at + 1 < letters.length ? letters.slice(at + 1) : undefined;
                    if (inline !== undefined) {
                        flags.archive = inline;
                        at = letters.length;
                        break;
                    }
                    const next = args[index + 1];
                    if (next === undefined) return 'option -f requires a value';
                    flags.archive = next;
                    index += 1;
                    continue;
                }
                if (letter === 'C') {
                    const inline = at + 1 < letters.length ? letters.slice(at + 1) : undefined;
                    if (inline !== undefined) {
                        flags.directories.push(inline);
                        at = letters.length;
                        break;
                    }
                    const next = args[index + 1];
                    if (next === undefined) return 'option -C requires a value';
                    flags.directories.push(next);
                    index += 1;
                    continue;
                }
                if (letter === 'c') flags.mode = 'create';
                else if (letter === 'x') flags.mode = 'extract';
                else if (letter === 't') flags.mode = 'list';
                else if (letter === 'v') flags.verbose = true;
                else if (letter === 'z') flags.gzip = true;
                else if (letter === 'j') flags.bzip2 = true;
                else if (letter === 'J') flags.xz = true;
                else if (letter === 'p') flags.preserve = true;
                else if (letter === 'k') flags.keepOld = true;
                else if (letter === 'm') flags.noMtime = true;
                else if (letter === 'O') flags.toStdout = true;
                else if (letter === 'h' || letter === 'n' || letter === 's' || letter === 'S' || letter === 'w') continue;
                else return `invalid option -- '${letter}'`;
            }
            index += 1;
            first = false;
            continue;
        }
        flags.operands.push(arg);
        index += 1;
        first = false;
    }
    return flags;
}

/** Whether an exclude pattern covers a member, one of its parents, or any of their last components. */
function isExcluded(name: string, excludes: string[]): boolean {
    if (excludes.length === 0) return false;
    const bare = name.endsWith('/') ? name.slice(0, -1) : name;
    const prefixes = [bare];
    let at = bare.lastIndexOf('/');
    while (at > 0) {
        prefixes.push(bare.slice(0, at));
        at = bare.lastIndexOf('/', at - 1);
    }
    const candidates: string[] = [];
    for (const prefix of prefixes) {
        candidates.push(prefix);
        candidates.push(baseName(prefix));
    }
    for (const pattern of excludes) {
        for (const candidate of candidates) {
            if (fnmatch(pattern, candidate)) return true;
        }
    }
    return false;
}

/** Whether a path is the root it is checked against or sits below it. */
function contained(root: string, target: string): boolean {
    if (target === root) return true;
    const prefix = root === '/' ? '/' : root + '/';
    return target.startsWith(prefix);
}

/** The members tar would write for one operand, walking it when it is a directory. */
function membersFor(
    fs: Fs,
    operand: string,
    base: string,
    excludes: string[],
    warnings: string[],
): TarMember[] {
    const absolute = operand.startsWith('/') ? clean(operand) : clean(base + '/' + operand);
    let stored = operand.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (stored === '' || stored === '.') stored = '.';
    if (stored.startsWith('/')) {
        if (!warnings.includes('tar: Removing leading / from member names')) {
            warnings.push('tar: Removing leading / from member names');
        }
        stored = stored.replace(/^\/+/, '');
    }
    const tree = walkTree(fs, absolute);
    const members: TarMember[] = [];
    for (const entry of tree) {
        const tail = entry.path.slice(absolute.length).replace(/^\/+/, '');
        const name = tail === '' ? stored + (entry.kind === 'dir' ? '/' : '') : stored + '/' + tail + (entry.kind === 'dir' ? '/' : '');
        if (isExcluded(name, excludes)) continue;
        const stat = fs.statPath(entry.path);
        const mtime = Math.floor((stat?.mtimeMs && stat.mtimeMs > 0 ? stat.mtimeMs : Date.now()) / 1000);
        const link = entry.kind === 'dir' ? undefined : linkTargetOf(fs, entry.path);
        const mode = entry.kind === 'dir' ? modeOf(fs, entry.path, 0o755) : link === undefined ? modeOf(fs, entry.path, 0o644) : 0o777;
        members.push({
            name,
            mode,
            uid: 0,
            gid: 0,
            size: entry.kind === 'dir' || link !== undefined ? 0 : stat?.size ?? 0,
            mtime,
            type: entry.kind === 'dir' ? '5' : link === undefined ? '0' : '2',
            linkname: link ?? '',
            uname: '',
            gname: '',
            prefix: '',
            data: entry.kind === 'dir' || link !== undefined ? null : readBinary(fs, entry.path) ?? new Uint8Array(0),
        });
    }
    return members;
}

/** Creates a symlink entry when the file system can represent one. */
function linkTargetOf(fs: Fs, path: string): string | undefined {
    const reader = extended(fs).readlink;
    if (typeof reader !== 'function') return undefined;
    try {
        const target = (reader as (p: string) => string | undefined).call(fs, path);
        return typeof target === 'string' ? target : undefined;
    } catch {
        return undefined;
    }
}

/** Restores a mode when the file system carries one; the virtual file system does not. */
function applyMode(fs: Fs, path: string, mode: number): void {
    const chmod = extended(fs).chmod;
    if (typeof chmod !== 'function') return;
    try {
        (chmod as (p: string, m: number) => void).call(fs, path, mode & 0o7777);
    } catch {
        /* no permission metadata on this file system */
    }
}

/** The permission bits of a path, for the file systems that keep them. */
function modeOf(fs: Fs, path: string, fallback: number): number {
    const statMode = extended(fs).statMode;
    if (typeof statMode === 'function') {
        try {
            const mode = (statMode as (p: string) => number).call(fs, path);
            if (typeof mode === 'number' && (mode & 0o7777) !== 0) return mode & 0o7777;
        } catch {
            /* fall back below */
        }
    }
    return fallback;
}

/** Restores a modification time when the file system carries one. */
function applyMtime(fs: Fs, path: string, seconds: number): void {
    const utimes = extended(fs).utimes;
    if (typeof utimes !== 'function') return;
    try {
        (utimes as (p: string, m: number) => void).call(fs, path, seconds * 1000);
    } catch {
        /* no timestamp metadata on this file system */
    }
}

/** Writes one extracted member. Returns false and reports when the member had to be refused. */
function writeTarMember(
    fs: Fs,
    member: TarMember,
    root: string,
    flags: TarFlags,
    errors: string[],
    stdout: string[],
): boolean {
    let name = member.name;
    if (name.startsWith('/')) name = name.replace(/^\/+/, '');
    if (name.split('/').includes('..')) {
        errors.push(`${member.name}: Path contains '..'`);
        return false;
    }
    const kind = kindOfFlag(member.type);
    const target = clean(root + '/' + name);
    if (!contained(root, target)) {
        errors.push(`${member.name}: Path contains '..'`);
        return false;
    }
    if (kind === 'other') {
        errors.push(`tar: ${member.name}: unsupported member type '${member.type}' -- skipped`);
        return false;
    }
    if (kind === 'hard') {
        errors.push(`tar: ${member.name}: hard link ignored (the virtual file system has no link metadata)`);
        return false;
    }
    if (kind === 'dir') {
        ensureDir(fs, target);
        applyMode(fs, target, member.mode);
        if (!flags.noMtime) applyMtime(fs, target, member.mtime);
        return true;
    }
    const parent = parentOf(target);
    if (!hasDir(fs, parent)) ensureDir(fs, parent);
    if (flags.keepOld && kindOf(fs, target) !== undefined) return true;
    const data = member.data ?? new Uint8Array(0);
    if (flags.toStdout && kind === 'file') {
        stdout.push(bytesToText(data));
        return true;
    }
    if (kind === 'link') {
        const maker = extended(fs).symlink;
        let made = false;
        if (typeof maker === 'function') {
            try {
                (maker as (t: string, p: string) => void).call(fs, member.linkname, target);
                made = true;
            } catch {
                made = false;
            }
        }
        if (!made) {
            try {
                writeBinary(fs, target, textToBytes(member.linkname));
            } catch (error) {
                errors.push(`tar: ${member.name}: ${reason(error)}`);
                return false;
            }
        }
        applyMode(fs, target, member.mode);
        return true;
    }
    try {
        writeBinary(fs, target, data);
    } catch (error) {
        errors.push(`tar: ${member.name}: ${reason(error)}`);
        return false;
    }
    applyMode(fs, target, member.mode);
    if (!flags.noMtime) applyMtime(fs, target, member.mtime);
    return true;
}

/** The tar body: create, extract or list. */
function runTar(ctx: CommandContext, args: string[]): CommandResult {
    const parsed = parseTarFlags(args);
    if (typeof parsed === 'string') return fail(`tar: ${parsed}`, 2);
    const flags = parsed;
    if (flags.bzip2) return noCodec('tar', 'bzip2');
    if (flags.xz) return noCodec('tar', 'xz');
    if (flags.mode === undefined) return fail('tar: you must specify exactly one of -c, -x or -t', 2);

    const warnings: string[] = [];
    const base = flags.directories.length > 0 ? clean(ctx.fs.resolvePath(flags.directories[flags.directories.length - 1], ctx.cwd)) : ctx.cwd;
    if (flags.mode !== 'create' && flags.directories.length > 0 && !hasDir(ctx.fs, base)) {
        return fail(`tar: could not chdir to '${flags.directories[flags.directories.length - 1]}'`, 1);
    }

    if (flags.mode === 'create') {
        if (flags.archive === undefined) return fail('tar: no archive given; use -f', 2);
        const members: TarMember[] = [];
        const operands = flags.operands.length > 0 ? flags.operands : ['.'];
        for (const operand of operands) {
            const found = membersFor(ctx.fs, operand, base, flags.excludes, warnings);
            if (found.length === 0) {
                warnings.push(`tar: ${operand}: Cannot stat: No such file or directory`);
                continue;
            }
            members.push(...found);
        }
        let bytes = buildTar(members);
        if (flags.gzip) bytes = gzipBytes(bytes, 6);
        if (flags.archive === '-') return finish(bytesToText(bytes), warnings.join('\n'), warnings.length > 0 ? 1 : 0);
        try {
            ensureDir(ctx.fs, parentOf(atPath(ctx, flags.archive)));
            writeBinary(ctx.fs, atPath(ctx, flags.archive), bytes);
        } catch (error) {
            return fail(`tar: ${flags.archive}: ${reason(error)}`, 1);
        }
        if (flags.verbose) {
            const lines = members.map((member) => member.name);
            return finish(lines.join('\n') + '\n', warnings.join('\n'), warnings.length > 0 ? 1 : 0);
        }
        return finish('', warnings.join('\n'), warnings.length > 0 ? 1 : 0);
    }

    let bytes: Uint8Array | undefined;
    if (flags.archive === undefined || flags.archive === '-') {
        bytes = textToBytes(ctx.input ?? '');
    } else {
        bytes = readBinary(ctx.fs, atPath(ctx, flags.archive));
        if (bytes === undefined) return fail(`tar: ${flags.archive}: Cannot open: No such file or directory`, 1);
    }
    if (isGzip(bytes)) {
        try {
            bytes = gunzipBytes(bytes);
        } catch (error) {
            return fail(`tar: ${flags.archive ?? '-'}: ${reason(error)}`, 1);
        }
    }
    const { members, error } = parseTar(bytes);
    if (error !== undefined) {
        const out = flags.mode === 'list' ? members.map((member) => member.name).join('\n') : '';
        return finish(out === '' ? '' : out + '\n', error, 1);
    }

    if (flags.mode === 'list') {
        const lines = members
            .filter((member) => !isExcluded(member.name, flags.excludes))
            .map((member) => (flags.verbose ? tarVerboseLine(member) : member.name));
        return finish(lines.length > 0 ? lines.join('\n') + '\n' : '', warnings.join('\n'), 0);
    }

    const errors: string[] = warnings.slice();
    const stdout: string[] = [];
    let worst = 0;
    for (const member of members) {
        if (isExcluded(member.name, flags.excludes)) continue;
        if (!writeTarMember(ctx.fs, member, base, flags, errors, stdout)) {
            worst = 1;
            continue;
        }
        if (flags.verbose && !flags.toStdout) stdout.push(`${member.name}\n`);
    }
    if (worst !== 0 && errors.length > 0) errors.push('tar: Error exit delayed from previous errors.');
    return finish(stdout.join(''), errors.join('\n'), worst);
}

/* --------------------------------------------------------------------- cpio */

/** The SVR4 ("newc") magic, the same layout with a checksum, and the old ASCII ("odc") magic. */
const CPIO_NEWC = '070701';
const CPIO_CRC = '070702';
const CPIO_ODC = '070707';
const CPIO_TRAILER = 'TRAILER!!!';

/** One cpio member. `data` is null for directories, which carry no payload. */
interface CpioEntry {
    name: string;
    ino: number;
    mode: number;
    uid: number;
    gid: number;
    nlink: number;
    mtime: number;
    size: number;
    data: Uint8Array | null;
}

/** The mode bits that say what a cpio member is. */
const CPIO_IFMT = 0o170000;
const CPIO_IFDIR = 0o040000;
const CPIO_IFREG = 0o100000;
const CPIO_IFLNK = 0o120000;

/** What a cpio member is, from its mode. */
function cpioKind(mode: number): 'file' | 'dir' | 'link' | 'other' {
    const masked = mode & CPIO_IFMT;
    if (masked === CPIO_IFDIR) return 'dir';
    if (masked === CPIO_IFREG) return 'file';
    if (masked === CPIO_IFLNK) return 'link';
    return 'other';
}

/** Eight hexadecimal digits. */
function hexField(bytes: Uint8Array, at: number): number {
    let value = 0;
    for (let index = at; index < at + 8; index++) {
        const digit = bytes[index];
        const hex = digit >= 0x30 && digit <= 0x39 ? digit - 0x30 : digit >= 0x41 && digit <= 0x46 ? digit - 0x41 + 10 : digit >= 0x61 && digit <= 0x66 ? digit - 0x61 + 10 : 0;
        value = value * 16 + hex;
    }
    return value >>> 0;
}

/** A run of octal digits. */
function octalField(bytes: Uint8Array, at: number, width: number): number {
    let text = '';
    for (let index = at; index < at + width; index++) text += String.fromCharCode(bytes[index] ?? 0x30);
    const parsed = Number.parseInt(text, 8);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** The 110-byte newc header. */
function cpioNewcHeader(entry: CpioEntry): Uint8Array {
    const fields = [entry.ino, entry.mode, entry.uid, entry.gid, entry.nlink, entry.mtime, entry.size, 0, 0, 0, 0, textToBytes(entry.name).length + 1, 0];
    let text = CPIO_NEWC;
    for (const field of fields) text += (field >>> 0).toString(16).toUpperCase().padStart(8, '0');
    return textToBytes(text);
}

/** The 76-byte old-ASCII header, whose timestamp and size fields are eleven digits wide. */
function cpioOdcHeader(entry: CpioEntry): Uint8Array {
    const widths: [number, number][] = [
        [0, 6],
        [entry.ino, 6],
        [entry.mode, 6],
        [entry.uid, 6],
        [entry.gid, 6],
        [entry.nlink, 6],
        [0, 6],
        [entry.mtime, 11],
        [textToBytes(entry.name).length + 1, 6],
        [entry.size, 11],
    ];
    let text = CPIO_ODC;
    for (const [value, width] of widths) {
        const octal = (value >>> 0).toString(8);
        text += octal.length >= width ? octal.slice(octal.length - width) : octal.padStart(width, '0');
    }
    return textToBytes(text);
}

/** Serializes members. newc pads the header and the payload to four bytes; odc pads nothing. */
function cpioBuild(entries: CpioEntry[], format: 'newc' | 'odc'): Uint8Array {
    const bytes: number[] = [];
    const push = (data: Uint8Array): void => {
        for (let index = 0; index < data.length; index++) bytes.push(data[index]);
    };
    const align = (): void => {
        while (bytes.length % 4 !== 0) bytes.push(0);
    };
    const trailer: CpioEntry = {
        name: CPIO_TRAILER,
        ino: 0,
        mode: 0,
        uid: 0,
        gid: 0,
        nlink: 1,
        mtime: 0,
        size: 0,
        data: null,
    };
    let inode = 1;
    for (const entry of entries.concat([trailer])) {
        if (format === 'newc') {
            push(cpioNewcHeader(entry));
            push(textToBytes(entry.name));
            bytes.push(0);
            align();
            if (entry.data && entry.data.length > 0) {
                push(entry.data);
                align();
            }
            continue;
        }
        push(cpioOdcHeader(entry));
        push(textToBytes(entry.name));
        bytes.push(0);
        if (entry.data && entry.data.length > 0) push(entry.data);
    }
    void inode;
    return new Uint8Array(bytes);
}

/** Reads a cpio archive in the newc, crc or odc format. */
function cpioParse(bytes: Uint8Array): { entries: CpioEntry[]; error?: string } {
    const entries: CpioEntry[] = [];
    let at = 0;
    const eof = { entries, error: 'cpio: premature end of archive' };
    while (at < bytes.length) {
        if (at + 6 > bytes.length) return eof;
        const magic = bytesToText(bytes.subarray(at, at + 6));
        if (magic === CPIO_NEWC || magic === CPIO_CRC) {
            if (at + 110 > bytes.length) return eof;
            const ino = hexField(bytes, at + 6);
            const mode = hexField(bytes, at + 14);
            const uid = hexField(bytes, at + 22);
            const gid = hexField(bytes, at + 30);
            const nlink = hexField(bytes, at + 38);
            const mtime = hexField(bytes, at + 46);
            const size = hexField(bytes, at + 54);
            const namesize = hexField(bytes, at + 94);
            const nameAt = at + 110;
            if (namesize < 1 || nameAt + namesize > bytes.length) return eof;
            const name = bytesToText(bytes.subarray(nameAt, nameAt + namesize - 1));
            let dataAt = nameAt + namesize;
            while (dataAt % 4 !== 0) dataAt += 1;
            if (dataAt + size > bytes.length) return eof;
            if (name === CPIO_TRAILER) return { entries };
            entries.push({
                name,
                ino,
                mode,
                uid,
                gid,
                nlink,
                mtime,
                size,
                data: size > 0 ? bytes.subarray(dataAt, dataAt + size) : null,
            });
            at = dataAt + size;
            while (at % 4 !== 0) at += 1;
            continue;
        }
        if (magic === CPIO_ODC) {
            if (at + 76 > bytes.length) return eof;
            const ino = octalField(bytes, at + 12, 6);
            const mode = octalField(bytes, at + 18, 6);
            const uid = octalField(bytes, at + 24, 6);
            const gid = octalField(bytes, at + 30, 6);
            const nlink = octalField(bytes, at + 36, 6);
            const mtime = octalField(bytes, at + 48, 11);
            const namesize = octalField(bytes, at + 59, 6);
            const size = octalField(bytes, at + 65, 11);
            const nameAt = at + 76;
            if (namesize < 1 || nameAt + namesize > bytes.length) return eof;
            const name = bytesToText(bytes.subarray(nameAt, nameAt + namesize - 1));
            const dataAt = nameAt + namesize;
            if (dataAt + size > bytes.length) return eof;
            if (name === CPIO_TRAILER) return { entries };
            entries.push({
                name,
                ino,
                mode,
                uid,
                gid,
                nlink,
                mtime,
                size,
                data: size > 0 ? bytes.subarray(dataAt, dataAt + size) : null,
            });
            at = dataAt + size;
            continue;
        }
        return { entries, error: 'cpio: bad magic' };
    }
    return { entries };
}

interface CpioFlags {
    mode: 'out' | 'in' | 'pass' | undefined;
    list: boolean;
    verbose: boolean;
    dots: boolean;
    makeDirs: boolean;
    unconditional: boolean;
    keepMtime: boolean;
    quiet: boolean;
    format: 'newc' | 'odc';
    file: string | undefined;
    operands: string[];
}

/** The flags cpio accepts. */
function parseCpioFlags(args: string[]): CpioFlags | string {
    const flags: CpioFlags = {
        mode: undefined,
        list: false,
        verbose: false,
        dots: false,
        makeDirs: false,
        unconditional: false,
        keepMtime: false,
        quiet: false,
        format: 'newc',
        file: undefined,
        operands: [],
    };
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--') {
            for (index += 1; index < args.length; index++) flags.operands.push(args[index]);
            break;
        }
        if (arg.startsWith('--')) {
            const { name, value } = splitLong(arg);
            if (name === '--create' || name === '--copy-out') flags.mode = 'out';
            else if (name === '--extract' || name === '--copy-in') flags.mode = 'in';
            else if (name === '--pass-through' || name === '--copy-pass') flags.mode = 'pass';
            else if (name === '--list' || name === '--table') flags.list = true;
            else if (name === '--verbose') flags.verbose = true;
            else if (name === '--dot') flags.dots = true;
            else if (name === '--make-directories') flags.makeDirs = true;
            else if (name === '--unconditional') flags.unconditional = true;
            else if (name === '--preserve-modification-time') flags.keepMtime = true;
            else if (name === '--quiet') flags.quiet = true;
            else if (name === '--format' || name === '--file') {
                const taken = takeValue(args, index, value);
                if (taken.value === undefined) return `option ${name} requires a value`;
                if (name === '--file') flags.file = taken.value;
                else {
                    if (taken.value === 'newc' || taken.value === 'crc') flags.format = 'newc';
                    else if (taken.value === 'odc' || taken.value === 'ustar' && false) flags.format = 'odc';
                    else return `unknown archive format: ${taken.value}`;
                }
                index = taken.next;
                continue;
            } else return `invalid option -- '${name}'`;
            index += 1;
            continue;
        }
        if (arg.length > 1 && arg[0] === '-') {
            for (let at = 1; at < arg.length; at++) {
                const letter = arg[at];
                if (letter === 'o') flags.mode = 'out';
                else if (letter === 'i') flags.mode = 'in';
                else if (letter === 'p') flags.mode = 'pass';
                else if (letter === 't') flags.list = true;
                else if (letter === 'v') flags.verbose = true;
                else if (letter === 'V') flags.dots = true;
                else if (letter === 'd') flags.makeDirs = true;
                else if (letter === 'u') flags.unconditional = true;
                else if (letter === 'm') flags.keepMtime = true;
                else if (letter === 'c') flags.format = 'odc';
                else if (letter === 'a' || letter === 'l' || letter === 'L' || letter === 'r' || letter === 's') continue;
                else if (letter === 'F' || letter === 'I' || letter === 'O' || letter === 'H') {
                    const inline = at + 1 < arg.length ? arg.slice(at + 1) : undefined;
                    const word = inline !== undefined ? inline : args[index + 1];
                    if (word === undefined) return `option -${letter} requires a value`;
                    if (letter === 'H') {
                        if (word === 'newc' || word === 'crc') flags.format = 'newc';
                        else if (word === 'odc') flags.format = 'odc';
                        else return `unknown archive format: ${word}`;
                    } else {
                        flags.file = word;
                    }
                    if (inline === undefined) index += 1;
                    at = arg.length;
                } else return `invalid option -- '${letter}'`;
            }
            index += 1;
            continue;
        }
        flags.operands.push(arg);
        index += 1;
    }
    return flags;
}

/** The names cpio reads from standard input, or from the files named as operands. */
function cpioNameList(ctx: CommandContext, operands: string[]): { names: string[]; error?: string } {
    if (operands.length === 0) {
        return { names: (ctx.input ?? '').split('\n').filter((line) => line !== '') };
    }
    try {
        const texts = inputText({ ...ctx, args: operands });
        const names: string[] = [];
        for (const entry of texts) {
            for (const line of entry.text.split('\n')) if (line !== '') names.push(line);
        }
        return { names };
    } catch (error) {
        return { names: [], error: reason(error) };
    }
}

/** One cpio member for a path on this file system. */
function cpioEntryFor(fs: Fs, path: string, name: string, inode: number): CpioEntry | undefined {
    const kind = kindOf(fs, path);
    if (kind === undefined) return undefined;
    const stat = fs.statPath(path);
    const mtime = Math.floor((stat?.mtimeMs && stat.mtimeMs > 0 ? stat.mtimeMs : Date.now()) / 1000);
    if (kind === 'dir') {
        return { name, ino: inode, mode: CPIO_IFDIR | modeOf(fs, path, 0o755), uid: 0, gid: 0, nlink: 2, mtime, size: 0, data: null };
    }
    const link = linkTargetOf(fs, path);
    if (link !== undefined) {
        const data = textToBytes(link);
        return { name, ino: inode, mode: CPIO_IFLNK | modeOf(fs, path, 0o755), uid: 0, gid: 0, nlink: 1, mtime, size: data.length, data };
    }
    const data = readBinary(fs, path) ?? new Uint8Array(0);
    return { name, ino: inode, mode: CPIO_IFREG | modeOf(fs, path, 0o644), uid: 0, gid: 0, nlink: 1, mtime, size: data.length, data };
}

/** The block count cpio reports when it finishes. */
function blocksText(bytes: Uint8Array): string {
    return `${Math.ceil(bytes.length / 512)} block${Math.ceil(bytes.length / 512) === 1 ? '' : 's'}`;
}

/** The cpio body: copy-out, copy-in or copy-pass. */
function runCpio(ctx: CommandContext, args: string[]): CommandResult {
    const parsed = parseCpioFlags(args);
    if (typeof parsed === 'string') return fail(`cpio: ${parsed}`, 2);
    const flags = parsed;
    if (flags.mode === undefined) return fail('cpio: you must specify exactly one of -o, -i or -p', 2);

    if (flags.mode === 'out') {
        const { names, error } = cpioNameList(ctx, flags.operands);
        if (error !== undefined) return fail(`cpio: ${error}`, 1);
        const entries: CpioEntry[] = [];
        const errors: string[] = [];
        let worst = 0;
        let inode = 1;
        for (const name of names) {
            const path = clean(ctx.fs.resolvePath(name, ctx.cwd));
            const entry = cpioEntryFor(ctx.fs, path, name, inode++);
            if (entry === undefined) {
                errors.push(`cpio: ${name}: No such file or directory`);
                worst = 1;
                continue;
            }
            entries.push(entry);
        }
        const bytes = cpioBuild(entries, flags.format);
        const note = flags.quiet ? '' : blocksText(bytes);
        if (flags.file !== undefined && flags.file !== '-') {
            try {
                writeBinary(ctx.fs, atPath(ctx, flags.file), bytes);
            } catch (writeError) {
                return fail(`cpio: ${flags.file}: ${reason(writeError)}`, 1);
            }
            return finish('', errors.concat(note === '' ? [] : [note]).join('\n'), worst);
        }
        return finish(bytesToText(bytes), errors.concat(note === '' ? [] : [note]).join('\n'), worst);
    }

    if (flags.mode === 'pass') {
        const destination = flags.operands[0];
        if (destination === undefined) return fail('cpio: -p requires a destination directory', 2);
        const root = clean(ctx.fs.resolvePath(destination, ctx.cwd));
        if (!hasDir(ctx.fs, root)) {
            if (!flags.makeDirs) return fail(`cpio: ${destination}: No such file or directory`, 1);
            ensureDir(ctx.fs, root);
        }
        const { names, error } = cpioNameList(ctx, []);
        if (error !== undefined) return fail(`cpio: ${error}`, 1);
        const errors: string[] = [];
        const lines: string[] = [];
        let worst = 0;
        for (const name of names) {
            const path = clean(ctx.fs.resolvePath(name, ctx.cwd));
            const kind = kindOf(ctx.fs, path);
            if (kind === undefined) {
                errors.push(`cpio: ${name}: No such file or directory`);
                worst = 1;
                continue;
            }
            const target = clean(root + '/' + name);
            if (!contained(root, target)) {
                errors.push(`cpio: ${name}: Path contains '..'`);
                worst = 1;
                continue;
            }
            if (kind === 'dir') {
                ensureDir(ctx.fs, target);
                if (flags.verbose) lines.push(name);
                continue;
            }
            const parent = parentOf(target);
            if (!hasDir(ctx.fs, parent)) {
                if (!flags.makeDirs) {
                    errors.push(`cpio: ${name}: No such file or directory`);
                    worst = 1;
                    continue;
                }
                ensureDir(ctx.fs, parent);
            }
            if (!flags.unconditional && kindOf(ctx.fs, target) !== undefined) continue;
            const data = readBinary(ctx.fs, path) ?? new Uint8Array(0);
            try {
                writeBinary(ctx.fs, target, data);
            } catch (writeError) {
                errors.push(`cpio: ${name}: ${reason(writeError)}`);
                worst = 1;
                continue;
            }
            applyMode(ctx.fs, target, 0o644);
            if (flags.keepMtime) {
                const stat = ctx.fs.statPath(path);
                if (stat && stat.mtimeMs > 0) applyMtime(ctx.fs, target, Math.floor(stat.mtimeMs / 1000));
            }
            if (flags.verbose) lines.push(name);
        }
        return finish(lines.length > 0 ? lines.join('\n') + '\n' : '', errors.join('\n'), worst);
    }

    let bytes: Uint8Array | undefined;
    if (flags.file !== undefined && flags.file !== '-') {
        bytes = readBinary(ctx.fs, atPath(ctx, flags.file));
        if (bytes === undefined) return fail(`cpio: ${flags.file}: No such file or directory`, 1);
    } else {
        bytes = textToBytes(ctx.input ?? '');
    }
    const { entries, error } = cpioParse(bytes);
    if (error !== undefined && entries.length === 0) return fail(error, 1);

    const lines: string[] = [];
    const errors: string[] = [];
    let worst = 0;
    const root = ctx.cwd;
    for (const entry of entries) {
        if (flags.operands.length > 0 && !flags.operands.some((pattern) => fnmatch(pattern, entry.name))) continue;
        const kind = cpioKind(entry.mode);
        if (flags.list) {
            lines.push(flags.verbose ? `${modeText(entry.mode & 0o7777, kind)} ${entry.uid} ${entry.gid} ${String(entry.size).padStart(9)} ${stampText(entry.mtime)} ${entry.name}` : entry.name);
            continue;
        }
        if (kind === 'other') {
            errors.push(`cpio: ${entry.name}: unsupported member type -- skipped`);
            worst = 1;
            continue;
        }
        if (entry.name.split('/').includes('..')) {
            errors.push(`cpio: ${entry.name}: Path contains '..'`);
            worst = 1;
            continue;
        }
        const target = clean(root + '/' + entry.name);
        if (!contained(root, target)) {
            errors.push(`cpio: ${entry.name}: Path contains '..'`);
            worst = 1;
            continue;
        }
        if (kind === 'dir') {
            ensureDir(ctx.fs, target);
            applyMode(ctx.fs, target, entry.mode & 0o7777);
            if (flags.keepMtime) applyMtime(ctx.fs, target, entry.mtime);
            if (flags.verbose || flags.dots) lines.push(entry.name);
            continue;
        }
        const parent = parentOf(target);
        /* Without -d a member whose parent is missing is skipped, the way the host cpio does it
         * (GNU cpio would report it). -d creates whatever the member needs. */
        if (!hasDir(ctx.fs, parent)) {
            if (!flags.makeDirs) continue;
            ensureDir(ctx.fs, parent);
        }
        if (!flags.unconditional && kindOf(ctx.fs, target) !== undefined) continue;
        if (kind === 'link') {
            const maker = extended(ctx.fs).symlink;
            let made = false;
            if (typeof maker === 'function') {
                try {
                    (maker as (t: string, p: string) => void).call(ctx.fs, bytesToText(entry.data ?? new Uint8Array(0)), target);
                    made = true;
                } catch {
                    made = false;
                }
            }
            if (!made) {
                try {
                    writeBinary(ctx.fs, target, entry.data ?? new Uint8Array(0));
                } catch (writeError) {
                    errors.push(`cpio: ${entry.name}: ${reason(writeError)}`);
                    worst = 1;
                    continue;
                }
            }
            /* No chmod on a symlink: it would land on whatever the link points at. */
            if (flags.keepMtime) applyMtime(ctx.fs, target, entry.mtime);
            if (flags.verbose) lines.push(entry.name);
            else if (flags.dots) lines.push('.');
            continue;
        }
        try {
            writeBinary(ctx.fs, target, entry.data ?? new Uint8Array(0));
        } catch (writeError) {
            errors.push(`cpio: ${entry.name}: ${reason(writeError)}`);
            worst = 1;
            continue;
        }
        applyMode(ctx.fs, target, entry.mode & 0o7777);
        if (flags.keepMtime) applyMtime(ctx.fs, target, entry.mtime);
        if (flags.verbose) lines.push(entry.name);
        else if (flags.dots) lines.push('.');
    }
    if (!flags.quiet) errors.push(blocksText(bytes));
    if (error !== undefined) {
        errors.push(error);
        worst = 1;
    }
    return finish(lines.length > 0 ? lines.join('\n') + '\n' : '', errors.join('\n'), worst);
}

/* ------------------------------------------------------------------ commands */

/**
 * Every command this module provides. The dispatcher looks a name up here before it considers
 * spawning a process, and a handler returns rather than throws for anything a user can provoke.
 */
export const COMMANDS: Record<string, ShellCommand> = {
    gzip: (ctx) => runGzip(ctx, 'gzip', ctx.args, '.gz', false),
    gunzip: (ctx) => runGzip(ctx, 'gunzip', ctx.args, '.gz', true),
    zcat: (ctx) => runGzip(ctx, 'zcat', ctx.args.concat(['-c']), '.gz', true),

    bzip2: unsupported('bzip2', 'bzip2'),
    bunzip2: unsupported('bunzip2', 'bzip2'),
    bzcat: unsupported('bzcat', 'bzip2'),

    xz: unsupported('xz', 'xz'),
    unxz: unsupported('unxz', 'xz'),
    xzcat: unsupported('xzcat', 'xz'),

    compress: (ctx) => runCompress(ctx, 'compress', ctx.args, false),
    uncompress: (ctx) => runCompress(ctx, 'uncompress', ctx.args, true),

    tar: (ctx) => runTar(ctx, ctx.args),
    cpio: (ctx) => runCpio(ctx, ctx.args),
};

