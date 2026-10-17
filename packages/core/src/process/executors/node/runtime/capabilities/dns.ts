import { CapabilityContext, CapabilityHandler } from './types';

/*
 * Host side of the guest's dns and dns/promises modules.
 *
 * Name resolution: IP literals and localhost resolve locally, and so do names in the container's
 * virtual name table (VirtualNetwork.registerHost) and in its /etc/hosts file. Every other name is asked of the DNS-over-HTTPS
 * JSON endpoint with fetch. A DNS query gets QUERY_BUDGET_MS; past that it is aborted and fails
 * with ETIMEOUT.
 */

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const QUERY_BUDGET_MS = 5000;

/** Record type numbers of the types sent to the DoH endpoint. */
const RR_NUMBERS: Record<string, number> = {
    A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, CAA: 257
};

/** Record types the guest may ask for. ANY is refused with ENOTIMP, as Node 24 reports on resolvers that do not answer it. */
const RRTYPES = ['A', 'AAAA', 'ANY', 'CAA', 'CNAME', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];

/** c-ares error names for the DNS response codes other than NOERROR. */
const RCODE_ERRORS: Record<number, string> = { 1: 'EFORMERR', 2: 'ESERVFAIL', 3: 'ENOTFOUND', 4: 'ENOTIMP', 5: 'EREFUSED' };

/** libuv's getaddrinfo error numbers. */
const UV_EAI_NONAME = -3008;
const UV_EAI_AGAIN = -3001;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/;

interface DnsAnswer {
    name: string;
    type: number;
    TTL?: number;
    data: string;
}

interface DnsMessage {
    Status?: number;
    Answer?: DnsAnswer[];
}

type DnsError = Error & { code: string; syscall: string; hostname: string; errno?: number };

interface Address {
    address: string;
    family: number;
}

interface LocalAddresses {
    v4: string[];
    v6: string[];
    /** Localhost and IP literals are not DNS names; registered names are. */
    literal: boolean;
}

interface Attempt {
    values: string[];
    failure?: DnsError;
}

function dnsError(code: string, syscall: string, hostname: string, errno?: number): DnsError {
    const error = new Error(`${syscall} ${code} ${hostname}`) as DnsError;
    error.code = code;
    error.syscall = syscall;
    error.hostname = hostname;
    if (errno !== undefined) error.errno = errno;
    return error;
}

const stripDot = (name: string): string => (name.endsWith('.') ? name.slice(0, -1) : name);

function syscallFor(rrtype: string): string {
    return `query${rrtype.charAt(0)}${rrtype.slice(1).toLowerCase()}`;
}

/** Eight 16-bit groups of an IPv6 literal, accepting an embedded dotted IPv4 tail. */
function ipv6Groups(text: string): number[] | undefined {
    let source = text.toLowerCase();
    if (source.includes('.')) {
        const cut = source.lastIndexOf(':');
        const quad = source.slice(cut + 1).split('.').map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
        if (quad.length !== 4 || quad.some((part) => !(part >= 0 && part <= 255))) return undefined;
        source = `${source.slice(0, cut + 1)}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
    }
    const halves = source.split('::');
    if (halves.length > 2) return undefined;
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
    let words: string[];
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return undefined;
        words = [...head, ...Array<string>(fill).fill('0'), ...tail];
    } else {
        words = head;
    }
    if (words.length !== 8) return undefined;
    const groups: number[] = [];
    for (const word of words) {
        if (!/^[0-9a-f]{1,4}$/.test(word)) return undefined;
        groups.push(parseInt(word, 16));
    }
    return groups;
}

/** RFC 5952 text form of an IPv6 literal. */
function canonicalIPv6(text: string): string | undefined {
    const groups = ipv6Groups(text);
    if (!groups) return undefined;
    let bestStart = -1;
    let bestLength = 0;
    for (let start = 0; start < 8;) {
        if (groups[start] !== 0) {
            start++;
            continue;
        }
        let end = start;
        while (end < 8 && groups[end] === 0) end++;
        if (end - start >= 2 && end - start > bestLength) {
            bestStart = start;
            bestLength = end - start;
        }
        start = end;
    }
    const hex = groups.map((group) => group.toString(16));
    if (bestStart < 0) return hex.join(':');
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

function ipFamily(text: string): 4 | 6 | undefined {
    if (IPV4.test(text)) return 4;
    return ipv6Groups(text) ? 6 : undefined;
}

function reverseName(ip: string, family: 4 | 6): string {
    if (family === 4) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const nibbles = (ipv6Groups(ip) ?? []).map((group) => group.toString(16).padStart(4, '0')).join('');
    return `${nibbles.split('').reverse().join('.')}.ip6.arpa`;
}

/** Presentation-format character strings: quoted strings keep their spaces; \DDD and \c escapes are decoded. */
function characterStrings(text: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] === ' ' || text[i] === '\t') {
            i++;
            continue;
        }
        if (text[i] === '"') {
            let value = '';
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) {
                    const decimal = text.slice(i + 1, i + 4);
                    if (/^\d{3}$/.test(decimal)) {
                        value += String.fromCharCode(Number(decimal));
                        i += 4;
                    } else {
                        value += text[i + 1];
                        i += 2;
                    }
                } else {
                    value += text[i];
                    i++;
                }
            }
            i++;
            out.push(value);
        } else {
            let end = i;
            while (end < text.length && text[end] !== ' ' && text[end] !== '\t') end++;
            out.push(text.slice(i, end));
            i = end;
        }
    }
    return out;
}

/** Answers of one wanted type. NXDOMAIN is ENOTFOUND; NOERROR without that type is ENODATA. */
async function queryRecords(name: string, rrtype: string, syscall: string): Promise<DnsAnswer[]> {
    const message = await fetchAnswer(name, rrtype, syscall);
    const status = message.Status ?? 0;
    if (status !== 0) throw dnsError(RCODE_ERRORS[status] ?? 'ESERVFAIL', syscall, name);
    const wanted = (message.Answer ?? []).filter((answer) => answer.type === RR_NUMBERS[rrtype]);
    if (wanted.length === 0) throw dnsError('ENODATA', syscall, name);
    return wanted;
}

/** One DoH request under the query budget; an overrun aborts the request and fails with ETIMEOUT. */
async function fetchAnswer(name: string, rrtype: string, syscall: string): Promise<DnsMessage> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(dnsError('ETIMEOUT', syscall, name));
        }, QUERY_BUDGET_MS);
    });
    try {
        return await Promise.race([requestMessage(name, rrtype, syscall, controller.signal), budget]);
    } finally {
        clearTimeout(timer);
    }
}

async function requestMessage(name: string, rrtype: string, syscall: string, signal: AbortSignal): Promise<DnsMessage> {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${rrtype}`;
    let response: Response;
    try {
        response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal });
    } catch {
        throw dnsError(signal.aborted ? 'ETIMEOUT' : 'ECONNREFUSED', syscall, name);
    }
    if (!response.ok) throw dnsError('ESERVFAIL', syscall, name);
    try {
        return (await response.json()) as DnsMessage;
    } catch {
        throw dnsError('EBADRESP', syscall, name);
    }
}

/** The records of one type in the shape Node 24 returns for it. */
function parseRecords(rrtype: string, answers: DnsAnswer[]): unknown {
    switch (rrtype) {
        case 'A':
            return answers.map((answer) => answer.data).filter((data) => IPV4.test(data));
        case 'AAAA':
            return answers.map((answer) => canonicalIPv6(answer.data)).filter((text): text is string => text !== undefined);
        case 'CNAME':
        case 'NS':
        case 'PTR':
            return answers.map((answer) => stripDot(answer.data));
        case 'MX':
            return answers.map((answer) => {
                const [priority, exchange = ''] = answer.data.trim().split(/\s+/);
                return { exchange: stripDot(exchange), priority: Number(priority), type: 'MX' };
            });
        case 'TXT':
            return answers.map((answer) => characterStrings(answer.data));
        case 'SRV':
            return answers.map((answer) => {
                const [priority, weight, port, target = ''] = answer.data.trim().split(/\s+/);
                return { name: stripDot(target), port: Number(port), priority: Number(priority), weight: Number(weight), type: 'SRV' };
            });
        case 'SOA': {
            const [nsname, hostmaster, serial, refresh, retry, expire, minttl] = answers[0].data.trim().split(/\s+/);
            return {
                nsname: stripDot(nsname),
                hostmaster: stripDot(hostmaster),
                serial: Number(serial),
                refresh: Number(refresh),
                retry: Number(retry),
                expire: Number(expire),
                minttl: Number(minttl),
                type: undefined
            };
        }
        case 'CAA':
            return answers.map((answer) => {
                const [flags, tag, value = ''] = characterStrings(answer.data);
                return { critical: Number(flags), type: 'CAA', [tag]: value };
            });
        case 'NAPTR':
            return answers.map((answer) => {
                const [order, preference, flags, service, regexp, replacement = ''] = characterStrings(answer.data);
                return {
                    flags,
                    service,
                    regexp,
                    replacement: stripDot(replacement),
                    order: Number(order),
                    preference: Number(preference),
                    type: undefined
                };
            });
        default:
            return answers.map((answer) => answer.data);
    }
}

/** Names this container knows locally: localhost, IP literals and the virtual name table. */
function localAddresses(name: string, ctx: CapabilityContext): LocalAddresses | undefined {
    if (name.toLowerCase() === 'localhost') return { v4: ['127.0.0.1'], v6: ['::1'], literal: true };
    const literal = ipFamily(name);
    if (literal !== undefined) {
        return literal === 4
            ? { v4: [name], v6: [], literal: true }
            : { v4: [], v6: [canonicalIPv6(name) ?? name], literal: true };
    }
    const registered = ctx.services.network.resolveHost(name);
    const addresses = registered !== undefined ? [registered] : hostsFileAddresses(name, ctx);
    if (addresses.length === 0) return undefined;
    return {
        v4: addresses.filter((address) => ipFamily(address) === 4),
        v6: addresses.filter((address) => ipFamily(address) === 6).map((address) => canonicalIPv6(address) ?? address),
        literal: false
    };
}

/** Addresses that the container's /etc/hosts file lists for a name, IPv4 and IPv6 in file order. */
export function hostsFileAddresses(name: string, ctx: CapabilityContext): string[] {
    const text = ctx.fileSystem.readFile('/etc/hosts');
    if (text === undefined) return [];
    const wanted = name.toLowerCase();
    const found: string[] = [];
    for (const line of text.split('\n')) {
        const [address = '', ...names] = line.split('#')[0].trim().split(/\s+/);
        if (ipFamily(address) !== undefined && names.some((alias) => alias.toLowerCase() === wanted)) found.push(address);
    }
    return found;
}

async function attempt(hostname: string, rrtype: string): Promise<Attempt> {
    try {
        const answers = await queryRecords(hostname, rrtype, 'getaddrinfo');
        return { values: parseRecords(rrtype, answers) as string[] };
    } catch (error) {
        return { values: [], failure: error as DnsError };
    }
}

async function emptyAttempt(): Promise<Attempt> {
    return { values: [] };
}

/** getaddrinfo-style resolution: IPv4 answers come before IPv6 ones. */
async function lookupAddresses(hostname: string, family: number, ctx: CapabilityContext): Promise<Address[]> {
    const literal = ipFamily(hostname);
    if (literal !== undefined) return [{ address: hostname, family: literal }];
    const local = localAddresses(hostname, ctx);
    if (local !== undefined) {
        const found: Address[] = [
            ...(family === 6 ? [] : local.v4).map((address) => ({ address, family: 4 })),
            ...(family === 4 ? [] : local.v6).map((address) => ({ address, family: 6 }))
        ];
        if (found.length === 0) throw dnsError('ENOTFOUND', 'getaddrinfo', hostname, UV_EAI_NONAME);
        return found;
    }
    const [v4, v6] = await Promise.all([
        family === 6 ? emptyAttempt() : attempt(hostname, 'A'),
        family === 4 ? emptyAttempt() : attempt(hostname, 'AAAA')
    ]);
    const found: Address[] = [
        ...v4.values.map((address) => ({ address, family: 4 })),
        ...v6.values.map((address) => ({ address, family: 6 }))
    ];
    if (found.length > 0) return found;
    const failures = [v4.failure, v6.failure].filter((failure): failure is DnsError => failure !== undefined);
    const hard = failures.find((failure) => failure.code !== 'ENOTFOUND' && failure.code !== 'ENODATA');
    if (hard?.code === 'ETIMEOUT') throw dnsError('ETIMEOUT', 'getaddrinfo', hostname);
    if (hard) throw dnsError('EAI_AGAIN', 'getaddrinfo', hostname, UV_EAI_AGAIN);
    throw dnsError('ENOTFOUND', 'getaddrinfo', hostname, UV_EAI_NONAME);
}

/** Reverse lookup. Loopback is answered locally; everything else is a PTR query on the reverse name. */
async function reverseNames(ip: string): Promise<string[]> {
    const family = ipFamily(ip);
    if (family === undefined) throw dnsError('EINVAL', 'getHostByAddr', ip, -22);
    if (ip === '127.0.0.1' || canonicalIPv6(ip) === '::1') return ['localhost'];
    try {
        const answers = await queryRecords(reverseName(ip, family), 'PTR', 'getHostByAddr');
        return answers.map((answer) => stripDot(answer.data));
    } catch (error) {
        const failure = error as DnsError;
        if (failure.code === undefined) throw failure;
        throw dnsError(failure.code === 'ENODATA' ? 'ENOTFOUND' : failure.code, 'getHostByAddr', ip);
    }
}

async function resolveQuery(name: string, rrtype: string, reverse: boolean, ctx: CapabilityContext): Promise<unknown> {
    if (rrtype === 'PTR' && (reverse || ipFamily(name) !== undefined)) return reverseNames(name);
    if (rrtype === 'ANY') throw dnsError('ENOTIMP', 'queryAny', name);
    const local = localAddresses(name, ctx);
    if (local !== undefined) {
        if (rrtype === 'A' || rrtype === 'AAAA') {
            const list = rrtype === 'A' ? local.v4 : local.v6;
            if (list.length === 0) throw dnsError('ENODATA', syscallFor(rrtype), name);
            return list;
        }
        throw dnsError(local.literal ? 'ENOTFOUND' : 'ENODATA', syscallFor(rrtype), name);
    }
    return parseRecords(rrtype, await queryRecords(name, rrtype, syscallFor(rrtype)));
}

export const DNS_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {hostname, family 0|4|6}. Result {address, family, addresses}, with addresses in lookup order. */
    'dns.lookup': async (args, ctx) => {
        const hostname = String(args?.hostname ?? '');
        if (hostname === '') throw dnsError('ENOTFOUND', 'getaddrinfo', hostname, UV_EAI_NONAME);
        const addresses = await lookupAddresses(hostname, Number(args?.family ?? 0), ctx);
        return { address: addresses[0].address, family: addresses[0].family, addresses };
    },
    /** Args {name, rrtype, reverse?}. Node-shaped records for the rrtype; reverse:true takes an IP as name. */
    'dns.resolve': async (args, ctx) => {
        const name = String(args?.name ?? '');
        const rrtype = String(args?.rrtype ?? 'A');
        if (!RRTYPES.includes(rrtype)) {
            throw Object.assign(new TypeError(`The argument 'rrtype' is invalid. Received '${rrtype}'`), { code: 'ERR_INVALID_ARG_VALUE' });
        }
        return resolveQuery(name, rrtype, args?.reverse === true, ctx);
    },
    /** Args {name, address}. Adds a name to the container's virtual name table. */
    'dns.register': (args, ctx) => {
        const name = String(args?.name ?? '');
        const address = String(args?.address ?? '');
        if (name === '') {
            throw Object.assign(new TypeError("The argument 'name' must be a non-empty string"), { code: 'ERR_INVALID_ARG_VALUE' });
        }
        if (ipFamily(address) === undefined) {
            throw Object.assign(new TypeError(`Invalid IP address: ${address}`), { code: 'ERR_INVALID_IP_ADDRESS' });
        }
        ctx.services.network.registerHost(name, address);
        return null;
    }
};
