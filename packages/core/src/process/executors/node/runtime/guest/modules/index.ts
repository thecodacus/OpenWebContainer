import { SRC as STREAM_SRC } from './stream';
import { SRC as PURE_A_SRC } from './pure-a';
import { SRC as PURE_B_SRC } from './pure-b';
import { SRC as ZLIB_SRC } from './zlib';
import { SRC as CHILD_SRC } from './child';
import { SRC as NET_SRC } from './net';
import { TLS_ENGINE_SRC } from './tls-engine';
import { TLS_SRC } from './tls';
import { QUIC_SRC } from './quic';
import { SRC as DNS_SRC } from './dns';
import { SRC as HTTP_SRC } from './http';
import { SRC as HTTP2_SRC } from './http2';
import { SRC as WEB_STREAMS_SRC } from './web-streams';
import { SRC as WEB_EVENTS_SRC } from './web-events';
import { SRC as INTL_SRC } from './intl';
import { SRC as UNDICI_SRC } from './undici';
import { NAPI_SRCS } from './napi';

/** Module families, each defining its built-ins as BF.<name> factories. Order matters only for globals. */
export const MODULE_SRCS: string[] = [
    STREAM_SRC,
    PURE_A_SRC,
    PURE_B_SRC,
    ZLIB_SRC,
    CHILD_SRC,
    NET_SRC,
    TLS_ENGINE_SRC,
    TLS_SRC,
    QUIC_SRC,
    DNS_SRC,
    HTTP_SRC,
    HTTP2_SRC,
    WEB_EVENTS_SRC,
    WEB_STREAMS_SRC,
    INTL_SRC,
    UNDICI_SRC,
    ...NAPI_SRCS
];
