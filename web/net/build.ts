#!/usr/bin/env node --experimental-strip-types
/**
 * build.ts — build the browser side of the virtual LAN: client.ts -> <out>/gxnet.js (types
 * stripped with node:module, no bundler; a plain script that sets window.GXNet).
 * The server (server.ts) runs as is with node --experimental-strip-types.
 *
 * Usage: node --experimental-strip-types web/net/build.ts [out]   (default web/net/dist)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "dist"));
mkdirSync(out, { recursive: true });

const strip = (nodeModule as any).stripTypeScriptTypes as ((src: string, opts?: object) => string) | undefined;
if (!strip) throw new Error("node:module has no stripTypeScriptTypes (needs Node 22.13 or newer)");

writeFileSync(join(out, "gxnet.js"), strip(readFileSync(join(here, "client.ts"), "utf8"), { mode: "strip" }));
console.log(`gxnet.js built into ${out}`);
