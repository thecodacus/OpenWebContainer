import { gunzipSync } from 'fflate';

export interface TarEntry {
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'other';
    data: Uint8Array;
}

const BLOCK_SIZE = 512;

/** Decompresses a .tgz archive and parses its ustar entries. */
export function extractTarGz(archive: Uint8Array): TarEntry[] {
    return parseTar(gunzipSync(archive));
}

/**
 * Parses a ustar archive, honouring pax extended headers (`x`) and GNU long names
 * (`L`). Entries whose paths would escape the package root are dropped.
 */
export function parseTar(tar: Uint8Array): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;
    let paxPath: string | undefined;
    let longName: string | undefined;

    while (offset + BLOCK_SIZE <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK_SIZE);
        if (header.every(byte => byte === 0)) break;

        const size = readOctal(header, 124, 12);
        const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const dataStart = offset + BLOCK_SIZE;
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

        if (typeflag === 'x') {
            paxPath = parsePaxPath(data) ?? paxPath;
            continue;
        }
        if (typeflag === 'g') continue;
        if (typeflag === 'L') {
            longName = readString(data, 0, data.length);
            continue;
        }

        const name = longName ?? paxPath ?? composeName(header);
        longName = undefined;
        paxPath = undefined;
        const path = normalizeEntryPath(name);
        if (path === undefined) continue;
        entries.push({
            path,
            type: entryType(typeflag),
            data: typeflag === '5' ? new Uint8Array() : data.slice()
        });
    }
    return entries;
}

function composeName(header: Uint8Array): string {
    const name = readString(header, 0, 100);
    const isUstar = readString(header, 257, 6).startsWith('ustar');
    const prefix = isUstar ? readString(header, 345, 155) : '';
    return prefix ? `${prefix}/${name}` : name;
}

function entryType(typeflag: string): TarEntry['type'] {
    if (typeflag === '0' || typeflag === '7') return 'file';
    if (typeflag === '5') return 'dir';
    if (typeflag === '2') return 'symlink';
    return 'other';
}

/** Strips leading `./` and rejects absolute or parent-escaping paths. */
function normalizeEntryPath(name: string): string | undefined {
    const segments = name.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..') || name.startsWith('/')) return undefined;
    return segments.join('/');
}

function readString(bytes: Uint8Array, start: number, length: number): string {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end++;
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

function readOctal(bytes: Uint8Array, start: number, length: number): number {
    const text = readString(bytes, start, length).trim();
    return text === '' ? 0 : parseInt(text, 8);
}

/** Pax records are `<length> <key>=<value>\n`; only `path` matters for extraction. */
function parsePaxPath(data: Uint8Array): string | undefined {
    const decoder = new TextDecoder();
    let path: string | undefined;
    let cursor = 0;
    while (cursor < data.length) {
        const space = data.indexOf(0x20, cursor);
        if (space < 0) break;
        const recordLength = parseInt(readString(data, cursor, space - cursor), 10);
        if (!recordLength) break;
        const record = decoder.decode(data.subarray(space + 1, cursor + recordLength - 1));
        const equals = record.indexOf('=');
        if (equals > 0 && record.slice(0, equals) === 'path') {
            path = record.slice(equals + 1);
        }
        cursor += recordLength;
    }
    return path;
}
