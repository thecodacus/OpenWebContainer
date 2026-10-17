import semver from 'semver';
import { bytesToBase64, bytesToHex } from '../utils/bytes';

export interface PackageVersion {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    os?: string | string[];
    cpu?: string | string[];
    libc?: string | string[];
    bin?: string | Record<string, string>;
    dist: {
        tarball: string;
        integrity?: string;
        shasum?: string;
    };
}

export interface Packument {
    name: string;
    'dist-tags': Record<string, string>;
    versions: Record<string, PackageVersion>;
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Minimal npm registry client: packuments (abbreviated install metadata) and tarballs,
 * with the integrity of every tarball verified before it is extracted.
 */
export class NpmRegistry {
    private packuments = new Map<string, Promise<Packument>>();
    private manifests = new Map<string, Promise<PackageVersion>>();

    constructor(
        private readonly baseUrl: string = DEFAULT_REGISTRY,
        private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)
    ) { }

    getPackument(name: string): Promise<Packument> {
        let cached = this.packuments.get(name);
        if (!cached) {
            cached = this.fetchPackument(name);
            this.packuments.set(name, cached);
            cached.catch(() => this.packuments.delete(name));
        }
        return cached;
    }

    async fetchTarball(version: PackageVersion): Promise<Uint8Array> {
        const response = await this.fetcher(version.dist.tarball);
        if (!response.ok) {
            throw new Error(`Failed to download ${version.name}@${version.version}: HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        await verifyIntegrity(bytes, version);
        return bytes;
    }

    /** The full manifest of one version. Install metadata omits libc, which only the full manifest carries. */
    getVersionManifest(name: string, version: string): Promise<PackageVersion> {
        const key = `${name}@${version}`;
        let cached = this.manifests.get(key);
        if (!cached) {
            cached = this.fetchVersionManifest(name, version);
            this.manifests.set(key, cached);
            cached.catch(() => this.manifests.delete(key));
        }
        return cached;
    }

    private async fetchVersionManifest(name: string, version: string): Promise<PackageVersion> {
        const response = await this.fetcher(`${this.baseUrl}${name.replace('/', '%2F')}/${version}`, {
            headers: { accept: 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`Registry responded ${response.status} for ${name}@${version}`);
        }
        return await response.json() as PackageVersion;
    }

    private async fetchPackument(name: string): Promise<Packument> {
        const url = this.baseUrl + name.replace('/', '%2F');
        const response = await this.fetcher(url, {
            headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*' }
        });
        if (response.status === 404) {
            throw new Error(`Package '${name}' not found in the registry`);
        }
        if (!response.ok) {
            throw new Error(`Registry responded ${response.status} for ${name}`);
        }
        return await response.json() as Packument;
    }
}

/**
 * Picks the version a spec resolves to: a dist-tag (or `latest` when empty), otherwise
 * the highest published version satisfying the semver range.
 */
export function selectVersion(packument: Packument, spec: string | undefined): PackageVersion {
    const wanted = spec === undefined || spec.trim() === '' ? 'latest' : spec.trim();
    const tagged = packument['dist-tags'][wanted];
    if (tagged !== undefined && packument.versions[tagged]) {
        return packument.versions[tagged];
    }
    if (semver.validRange(wanted) === null) {
        throw new Error(`Invalid version or range '${wanted}' for ${packument.name}`);
    }
    const best = semver.maxSatisfying(Object.keys(packument.versions), wanted);
    if (best === null) {
        throw new Error(`No matching version found for ${packument.name}@${wanted}`);
    }
    return packument.versions[best];
}

export async function verifyIntegrity(bytes: Uint8Array, version: PackageVersion): Promise<void> {
    const label = `${version.name}@${version.version}`;
    if (version.dist.integrity) {
        for (const entry of version.dist.integrity.split(/\s+/).filter(Boolean)) {
            const dash = entry.indexOf('-');
            const algorithm = entry.slice(0, dash);
            const expected = entry.slice(dash + 1);
            const digestName = algorithm === 'sha512' ? 'SHA-512' : algorithm === 'sha384' ? 'SHA-384' : algorithm === 'sha256' ? 'SHA-256' : undefined;
            if (!digestName) continue;
            const digest = new Uint8Array(await crypto.subtle.digest(digestName, bytes));
            if (bytesToBase64(digest) !== expected) {
                throw new Error(`Integrity check failed for ${label} (${algorithm})`);
            }
            return;
        }
    }
    if (version.dist.shasum) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
        if (bytesToHex(digest) !== version.dist.shasum) {
            throw new Error(`Integrity check failed for ${label} (shasum)`);
        }
    }
}
