# tools/asset-pipeline — asset pipeline tooling (TypeScript, Node ≥ 22.18)

No build step: Node strips types natively (`node --experimental-strip-types` on 22.x,
unflagged on 23+).

## big.ts — BIGF archive reader/writer

```bash
node --experimental-strip-types tools/asset-pipeline/big.ts list    web-dist/assets/INIZH.big
node --experimental-strip-types tools/asset-pipeline/big.ts extract web-dist/assets/INIZH.big /tmp/inizh --filter object
node --experimental-strip-types tools/asset-pipeline/big.ts cat     web-dist/assets/INIZH.big Data/INI/Object/AmericaInfantry.ini
node --experimental-strip-types tools/asset-pipeline/big.ts pack    my-assets-dir  web-dist/assets/CustomZH.big
```

Format is the one the engine reads in
`Core/GameEngineDevice/Source/Win32Device/Common/Win32BIGFileSystem.cpp` and
`GeneralsMD/.../WW3D2/gles3_big_vfs.cpp`: `BIGF`, u32 LE archive size, u32 BE
entry count, u32 BE table size, then `u32 BE offset, u32 BE size, path\0` per
entry, uncompressed data. `pack` produces archives the engine (and the web VFS)
mounts directly — this is how replacement/free assets will be shipped.

Planned next: `inventory.ts` — dependency graph INI → W3D → textures → audio for
one object, to list exactly which files a free-asset set must provide.
