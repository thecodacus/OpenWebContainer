/**
 * npm's os, cpu and libc package fields, matched against the platform the container reports:
 * the guest `os` module answers linux on x64, and libc on linux is glibc.
 */
export const CONTAINER_PLATFORM = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

/** A package's platform fields: a string or a list, where a `!name` entry blocks that value. */
export interface PlatformFields {
    os?: string | string[];
    cpu?: string | string[];
    libc?: string | string[];
}

/** npm's list rule: a `!name` entry blocks that value, plain entries form an allowlist, and no list accepts anything. */
function listAccepts(list: string | string[] | undefined, current: string): boolean {
    if (list === undefined) return true;
    const entries = (Array.isArray(list) ? list : [list]).filter((entry) => typeof entry === 'string');
    if (entries.includes(`!${current}`)) return false;
    const allowed = entries.filter((entry) => !entry.startsWith('!'));
    return allowed.length === 0 || allowed.includes(current);
}

/** The platform fields when they exclude the container's platform, or undefined when the package installs here. */
export function platformMismatch(fields: PlatformFields): PlatformFields | undefined {
    const accepted = listAccepts(fields.os, CONTAINER_PLATFORM.os)
        && listAccepts(fields.cpu, CONTAINER_PLATFORM.cpu)
        && listAccepts(fields.libc, CONTAINER_PLATFORM.libc);
    return accepted ? undefined : fields;
}

/** The wanted fields and the current platform, worded the way npm's EBADPLATFORM message has them. */
export function platformDescription(fields: PlatformFields): { wanted: string; current: string } {
    const wanted: PlatformFields = {};
    if (fields.os !== undefined) wanted.os = fields.os;
    if (fields.cpu !== undefined) wanted.cpu = fields.cpu;
    if (fields.libc !== undefined) wanted.libc = fields.libc;
    return { wanted: JSON.stringify(wanted), current: JSON.stringify(CONTAINER_PLATFORM) };
}
