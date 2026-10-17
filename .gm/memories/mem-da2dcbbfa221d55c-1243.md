---
key: mem-da2dcbbfa221d55c-1243
ns: default
created: 1792046816227
updated: 1792046816227
---

OWC QUIC stage 2 (2026-10-14, delivered /tmp/owc-r4/deliver/quic-stage2): guest QUIC runs as an esbuild bundle of src/network/quic (guest-entry.ts) generated into guest/modules/quic.ts by scripts/build-quic-guest.mjs; './crypto' resolves to guest-crypto.ts (callCap: crypto.hmac, tls.aead.*, new quic.hp.mask). QUIC_SRC is lazy: OWC_QUIC() compiles on first use (eager compile cost ~18 ms per guest process; lazy lexing ~5-7 ms). Internal builtin require('owc:internal/quic'). Gotchas: (1) Buffer.prototype.slice is a VIEW in Node and in the OWC guest; stage 1 removeHeaderProtection writes the unmasked header into packet.slice(), so opening a Buffer datagram twice fails authentication -- copy datagrams to plain Uint8Array at the socket boundary. (2) aioquic asyncio connect(wait_connected=False) transmits nothing until proto.transmit(). (3) aioquic request_key_update() ignores the RFC 9001 6.1 ACK precondition; space updates one round apart or tolerate consecutive updates. (4) aioquic emits ConnectionTerminated only after its draining period (~3 PTO); wait before killing it. (5) the OWC bridge (all copies) has no UDP loss hook. Witness driver: /tmp/owc-r4/impl-quic2/probe/container-witness.mts (OWC_CORE env selects the core copy).
