---
key: mem-0ccb19c34bcc30fe-725
ns: default
created: 1792107037214
updated: 1792107037214
---

## Resolved mutable: owc-cjs-filename-general-fix

CJS modules are compiled by the host with their file name (host.compileCjs in runtime/host-bridge.ts, called from runtime/guest/loader.ts), because this QuickJS build names eval'd code <input> and ignores //# sourceURL. Blast radius measured twice on the 148-entry corpus: the control tree reproduced the baseline with 0 status and 0 detail differences; the fixed tree showed exactly one change, better-sqlite3-native RUNTIME_ERROR -> PASS (5). Live dispatch 1792105930307-500-3fc023e47bbd7221 shows the container printing 5, identical to Node. Also affected and fixed: callsites@4.x and parent-module@2.x; not affected: @mapbox/node-pre-gyp, node-gyp-build, pkg-prebuilds.
