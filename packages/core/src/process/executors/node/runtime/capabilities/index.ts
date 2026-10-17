import { CapabilityHandler } from './types';
import { MISC_CAPABILITIES } from './misc';
import { ZLIB_CAPABILITIES } from './zlib';
import { CHILD_CAPABILITIES } from './child';
import { DNS_CAPABILITIES } from './dns';
import { NET_CAPABILITIES } from './net';
import { HTTP_CAPABILITIES } from './http';
import { CRYPTO_CAPABILITIES } from './crypto';
import { TLS_CRYPTO_CAPABILITIES } from './tls-crypto';
import { QUIC_CRYPTO_CAPABILITIES } from './quic-crypto';
import { INTL_CAPABILITIES } from './intl';
import { VM_CAPABILITIES } from './vm';

/** Every host operation a guest may call, by name. Each area file owns its own operations. */
export const CAPABILITIES: Record<string, CapabilityHandler> = {
    ...MISC_CAPABILITIES,
    ...ZLIB_CAPABILITIES,
    ...CHILD_CAPABILITIES,
    ...DNS_CAPABILITIES,
    ...NET_CAPABILITIES,
    ...HTTP_CAPABILITIES,
    ...CRYPTO_CAPABILITIES,
    ...TLS_CRYPTO_CAPABILITIES,
    ...QUIC_CRYPTO_CAPABILITIES,
    ...INTL_CAPABILITIES,
    ...VM_CAPABILITIES
};
