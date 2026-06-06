# Terrain catalog scale and LOD graph

Addressing [NOTES.md](../../NOTES.md): full manifest load, scene with all known nodes, VRAM thrashing when zoomed out, need to abort non-visible loads and evict under pressure. Complements [docs/tile-layers.md](../tile-layers.md) (runtime channel API) with **catalog and scene-graph** design.

## Related docs

- [docs/tile-layers.md](../tile-layers.md) § _Visibility model_ — frustum transitions, working-set budget (runtime enforcement).
- [v2-pyramid-pipeline.md](v2-pyramid-pipeline.md) — **implemented** on-disk `tc-dsm-pyramid` format and derivation contract.
- [storage-and-pipeline-v2.md](storage-and-pipeline-v2.md) — longer-term pipeline ops (segments, v1 reindex, Zarr).
- [dataset-operations.md](dataset-operations.md) — which manifest URL is active.
- [sqlite-catalog.md](sqlite-catalog.md) — per-dataset `index.db` + bounds queries as an alternative to JSON shard trees.

## Current behaviour (problem)

```mermaid
sequenceDiagram
  participant App as TerrainRenderer
  participant Cat as loadTerrainDatasetCatalog
  participant Net as HTTP shards
  participant Scene as dsmLayer
  App->>Cat: fetch manifest + all shards
  Cat->>Net: parallel shard GETs
  Net-->>Cat: full tile records
  Cat-->>App: Record key → DsmCatItem
  loop every catalog entry
    App->>Scene: new LazyTile (placeholder mesh)
  end
  Note over Scene: thousands of Object3Ds exist before any are visible
  Scene->>Scene: onBeforeRender → JP2 decode (no abort)
```

Evidence in code:

- [src/geo/terrainDatasetCatalog.ts](../../src/geo/terrainDatasetCatalog.ts) — `Promise.all` over **all** `manifest.index.shards`; builds complete `catalog` object.
- [src/geo/TileLoaderUK.ts](../../src/geo/TileLoaderUK.ts) `makeTiles` — `Object.entries(catalog).forEach` → `this.tiles.push(new LazyTile(...))` for **every** tile.
- [src/geo/TileLoaderUK.ts](../../src/geo/TileLoaderUK.ts) `LazyTile` — load starts on first `onBeforeRender`; no `AbortSignal`, no unload when off-screen.
- [src/geo/LodUtils.ts](../../src/geo/LodUtils.ts) — `GeoLOD` picks among 12 **geometric** resolutions per tile, but does not reduce **how many tiles** exist in the scene; `sources[2000|1000|500]` in catalog items is not populated from v1 shards (only `'1000'` today).

At national scale this implies:

- Large startup memory (full catalog map + N placeholders).
- Zoomed-out camera still intersects many placeholders → many overlapping JP2 decodes and GPU textures.
- Multi-GB `index/` download even if the viewport needs a handful of shards ([NOTES.md](../../NOTES.md)).

## Target: two-level spatial structure

Separate **metadata tree** (what exists, where, at what resolution) from **scene nodes** (what is instantiated and what channels are loaded).

### 1. Hierarchical catalog index (on disk / over network)

**Implemented format:** `psychogeo.terrain.v2` / `tc-dsm-pyramid` — OSGB-nested manifests under `pyramid/{cell}/`, columnar `leaf.enc`, merged branch overviews. Spec: [v2-pyramid-pipeline.md](v2-pyramid-pipeline.md). Pipeline reader: [v2/reader.ts](../../scripts/pipelines/defra-terrain/v2/reader.ts).

Evolution from v1: flat shard list + fat per-tile records → **spatial tree** where each node owns only encoding scalars; bounds and URLs are derived.

| Tier | Node example | Manifest carries |
|------|--------------|------------------|
| 10 km | `SP51` | `children[]`, `levels.2` (32 m merged) |
| 5 km | `SP51ne` | `levels.1` (8 m merged), `leaf.enc` (25× columnar) |
| 1 km | (derived slots) | HTJ2K at `0/{east}_{north}.j2c` — no per-slot manifest rows |

Legacy v1 index shape (still supported at runtime):

| Level | Node carries | Child linkage |
|-------|----------------|---------------|
| Root | dataset bounds, channel summary, child href | 4 (or N) quadrant children |
| Branch | aggregated bounds, tile count, max resolution | children or leaf shard href |
| Leaf shard | minimal tile table **or** pointer into columnar sidecar | — |

Per-tile records at leaf should hold only:

- `tileId`, `nominalExtent`, channel payload pointer + encoding scalars (min/max/scale).
- Pointer is either a per-tile `href` (v1) or **`segmentHref` + `byteOffset` + `byteLength`** for contiguous packed blobs fetched via HTTP Range ([storage-and-pipeline-v2.md](storage-and-pipeline-v2.md) § _Contiguous segment files_).
- **Not** duplicated dataset-level prose, full provenance arrays, or per-channel quality stats on every row (those belong in dataset manifest or a provenance sidecar keyed by `tileId`).

Redundancy today: each `TileRecord` in a shard repeats extent, encoding metadata, and provenance suitable for dataset-level documentation — contributing to multi-GB `index/` ([NOTES.md](../../NOTES.md)).

**Query API** (browser or thin server):

```
// v2 (implemented in pipeline reader; port to browser)
resolveChunksInBounds(datasetRoot, bounds, targetPyramidLevel?) → ChunkFetchDescriptor[]

// v1 / generic target
getIndexNode(manifest, east, north, depth?) → { children?, tiles?, channels? }
```

Viewport-driven: fetch `metadata.json` → descend into intersecting node manifests only. At leaf tier, slot indices are **pure arithmetic** (no chunk array scan). See [v2-pyramid-pipeline.md § Derivation contract](v2-pyramid-pipeline.md#derivation-contract).

**Alternative:** per-dataset **`index.db`** (SQLite + R-tree) with a single bounds query — same viewport driver, fewer HTTP round-trips than a deep JSON tree. Evaluated in [sqlite-catalog.md](sqlite-catalog.md). The frontend query API (`getIndexNode` / `tiles-in-bounds`) should be storage-agnostic so JSON quadtree and SQLite are interchangeable behind the proxy.

### 2. Scene graph: sparse tile nodes

Replace "create all `LazyTile` at startup" with a **TileTree** owned by the terrain renderer:

| State | Scene contents |
|-------|----------------|
| Cold | Empty layer or coarse aggregate node (future basemap / overview channel) |
| Warm | Branch nodes bound to a **coarse raster pyramid level** (overview HTJ2K); simple mesh, no leaf payload |
| Hot | Leaf `TileNode` bound to **fine pyramid level**; `GeoLOD` procedural meshes + channels per [tile-layers.md](../tile-layers.md) |

```mermaid
flowchart TB
  Cam[Camera + viewshed cameras]
  Tree[TileTree spatial index]
  Idx[Hierarchical manifest]
  Cam --> Tree
  Tree -->|query bounds| Idx
  Tree -->|spawn/despawn| Nodes[TileNode instances]
  Nodes --> Mgr[TileLayerManager future]
  Mgr --> Ch[RasterChannel loads]
```

**Invariants**

- Number of `TileNode` instances ≈ visible tiles × small constant, not catalog cardinality.
- Descending the index tree and spawning nodes are the same visibility decision (shared frustum test).
- Off-screen tile: cancel in-flight channel load (`AbortSignal`); optionally despawn node or strip channels keep geometry shell.

### 3. Geometric LOD vs raster pyramid (keep separate)

Two independent knobs — do not map `GeoLOD` level 1:1 to catalog pyramid level.

#### Geometric LOD (rendering, ~unchanged)

[`GeoLOD`](../../src/geo/LodUtils.ts) keeps the current character: **~12 procedural mesh densities** per active tile node — subsampled triangle grids from the same 4096² topology, chosen by camera distance (and viewshed observer) to the tile bounds. This controls **how many vertices sample the bound height texture**, not which HTJ2K file exists on disk.

- Same vertex-displacement / `gl_VertexID` shader model as today.
- A leaf tile at full raster resolution can still drop to mesh level 8 when far away — fewer triangles, **same** decoded texture.
- Near the camera, mesh level rises toward the cap; raster payload does not need to change for that transition.

#### Raster pyramid (data + scene graph)

The **catalog / spatial hierarchy** carries **discrete encoded resolutions** (e.g. 8 m overview, 2 m regional, 1 m leaf), as in [storage-and-pipeline-v2.md](storage-and-pipeline-v2.md) `L0…Ln` or merged overview tiles. **Scene-graph nodes** at different tree depths are associated with different pyramid levels:

| Scene-graph role | Raster | Mesh (procedural) |
|------------------|--------|-------------------|
| Root / branch | Coarse pyramid href (fewer pixels, wider extent) | Fixed coarse grid or limited `GeoLOD` band — enough to displace, not 12 full bands |
| Leaf | Fine pyramid href for nominal 1 m (or DTM 10 m) | Full `GeoLOD` stack as today |

Zoom **out**: ascend the tree (or stop instantiating leaves) → swap to parent node’s coarse raster. Zoom **in**: descend → spawn leaves and attach fine pyramid channel. That is independent of which of the 12 mesh levels `GeoLOD` picks inside a leaf.

```mermaid
flowchart TB
  subgraph spatial [Spatial scene graph]
    Root[Root node — pyramid L0]
    Branch[Branch — pyramid L1]
    Leaf[Leaf — pyramid Ln]
    Root --> Branch --> Leaf
  end
  subgraph perLeaf [Per leaf tile only]
    GeoLOD[GeoLOD levels 0–11]
    Tex[One HTJ2K at Ln]
    GeoLOD -->|samples| Tex
  end
  Leaf --> perLeaf
```

#### Channel / catalog shape

Raster pyramid levels appear in the index as explicit keys (not `'1000'` only):

```ts
// Illustrative — channel payload keyed by pyramid, not by GeoLOD level
channels: {
  'height.dsm.fz': {
    pyramid: {
      L0: { href, resolutionMetres: 8, … },
      L2: { href, resolutionMetres: 2, … },
      L5: { href, resolutionMetres: 1, … },
    },
  },
}
```

`RasterChannel.load` receives `TileLoadContext` with **pyramid level** (from tree depth / zoom) and **geometric lodLevel** (from `GeoLOD`) separately. The manager picks href from pyramid; `GeoLOD` only toggles mesh children.

#### Pipeline options (raster side only)

| Approach | Catalog | Scene graph |
|----------|---------|-------------|
| **A. Leaf-only pyramid** | One href per leaf tile (today) | Branches are spatial placeholders only; geometric LOD only savings |
| **B. Per-tile multiscale** | `L0…Ln` hrefs on each leaf record | Branches optional; coarse levels used when leaf not spawned |
| **C. Merged overviews** | Branch nodes own coarse HTJ2K covering many leaves | Strong match to §2 Warm/Hot split; clearest zoom-out path |

Recommendation: **C** (merged overviews) — **now emitted by v2 pipeline** at 8 m / 32 m defaults. **Keep `GeoLOD` as-is** inside leaves. Winchester / legacy v1 datasets stay on approach **A** until the v2 catalog path lands in the app.

Populate channel records with pyramid level keys from `tileMatrixSet.levels[]`; do not overload them as geometric LOD indices.

## Frontend rendering (v2 datasets)

The v2 pipeline is implemented; the **browser still loads v1** via [terrainDatasetCatalog.ts](../../src/geo/terrainDatasetCatalog.ts) and [TileLoaderUK.ts](../../src/geo/TileLoaderUK.ts). This section plans the migration.

### Design constraints (unchanged)

- **Geometric LOD** ([LodUtils.ts](../../src/geo/LodUtils.ts)) — 12 procedural mesh densities per *active* tile node; samples the bound height texture. Independent of pyramid level.
- **Raster pyramid** — discrete encoded resolutions on disk; scene-graph depth picks which `.j2c` to fetch. v2 provides L0 (1 m leaves), L1 (8 m @ 5 km), L2 (32 m @ 10 km) by default.

### Target data flow

```mermaid
sequenceDiagram
  participant Cam as Camera
  participant Tree as TileTree
  participant Cat as PyramidCatalog
  participant Net as HTTP
  participant Mgr as TileLayerManager
  participant Geo as GeoLOD

  Cam->>Tree: frustum bounds + screen scale
  Tree->>Cat: resolveChunksInBounds(bounds, pyramidLevel)
  Cat->>Net: metadata + 1–4 node manifests
  Cat-->>Tree: ChunkFetchDescriptor[]
  Tree->>Mgr: observeVisibility(tileNode, pyramidLevel)
  Mgr->>Net: GET .j2c (AbortSignal)
  Mgr->>Tree: RasterPayload texture
  Tree->>Geo: mesh density from camera distance
```

### Implementation phases

#### R1 — Shared derive module

- Port [v2/derive.ts](../../scripts/pipelines/defra-terrain/v2/derive.ts) and [v2/osgb.ts](../../scripts/pipelines/defra-terrain/v2/osgb.ts) to `src/geo/pyramidDerive.ts` (or re-export from a shared package). **No behaviour drift** — browser and pipeline must share tests or golden vectors.
- Port zod schemas (or generate JSON Schema) for runtime validation of fetched manifests.

#### R2 — PyramidCatalog loader

New module `src/geo/pyramidCatalog.ts`:

- `loadPyramidDataset(manifestUrl)` — fetch root `metadata.json` (note: v2 uses `metadata.json`, not v1 `manifest.json`).
- `resolveChunksInBounds(catalog, bounds, targetLevel?)` — mirror [v2/reader.ts](../../scripts/pipelines/defra-terrain/v2/reader.ts); return `{ url, encoding, eastMin, northMin, width, height, pyramidLevel }`.
- `pickPyramidLevel(metadata, viewportMetres)` — coarsest level with adequate ground resolution for screen coverage; iterate `tileMatrixSet.levels[]` (no hardcoded level count).

**Acceptance:** Given a v2 dataset URL and viewport, ≤ 5 manifest fetches and payload GET count ≈ visible chunks.

#### R3 — TileTree + pyramid-aware nodes

Replace eager `makeTiles` loop with [TileTree](#2-scene-graph-sparse-tile-nodes):

| Camera state | Nodes spawned | Raster attached |
|--------------|---------------|-----------------|
| Zoomed out (large viewport) | 0–1 node @ 10 km | `levels.2` merged chunk (32 m) |
| Medium | 1–4 nodes @ 5 km | `levels.1` merged chunk (8 m) each |
| Zoomed in | 1 km slots in view | `leaf.enc` L0 per visible slot |

- Node extent from `gridRefToBounds`; no catalog entry per tile at startup.
- Descend from cell root only into quadrants intersecting frustum (+ viewshed frustum when applicable).

**Acceptance:** Object3D count proportional to visible area; national v2 dataset does not create 10⁴+ placeholders at boot.

#### R4 — RasterChannel integration

Wire [tile-layers.md](../tile-layers.md) API:

- Extend `TileLoadContext` with `pyramidLevel: number` (separate from geometric `lodLevel`).
- `height.primary` channel: fetch URL from `ChunkFetchDescriptor`; apply `encoding` scalars for shader denormalisation (same as v1 `min/max/scale/offset`).
- `AbortSignal` on fetch/decode; evict texture when node leaves frustum.

**Acceptance:** Pan/zoom stable VRAM; zoom out cancels in-flight leaf decodes when switching to merged L1/L2.

#### R5 — App wiring

- [App.tsx](../../src/App.tsx) / dataset config: support `metadata.json` URL for v2 datasets (detect `schemaVersion`).
- [start-server.js](../../src/start-server.js): static serve unchanged (`/terrain-datasets/.../metadata.json`).
- Optional: compat shim that reads v2 and exposes v1-shaped catalog for incremental migration (defer unless needed).

### v1 vs v2 at runtime

| | v1 | v2 |
|---|----|----|
| Root file | `manifest.json` | `metadata.json` |
| Index | flat `index/*.json` shards | nested `pyramid/{cell}/…/manifest.json` |
| Startup fetch | all shards | metadata + viewport manifests |
| Coarse zoom | `height.dsm.base` (optional, rarely loaded) | merged `levels.1`, `levels.2` by design |
| Catalog API | `loadTerrainDatasetCatalog` | `PyramidCatalog.resolveChunksInBounds` |

### 4. Load cancellation and memory pressure

Map directly onto [tile-layers.md](../tile-layers.md):

| Today | Target |
|-------|--------|
| `onBeforeRender` one-shot load | `TileLayerManager.observeVisibility` |
| `lossyGeneration` counter in compression experiment | `AbortSignal` per channel load |
| No eviction | Working-set LRU on `RasterPayload.bytes` |
| All tiles in `this.tiles[]` | Tree + optional weak ref to hot nodes |

**Near-term bridge** (before full manager):

1. Frustum poll each frame; maintain `visibleSet: Set<tileId>`.
2. Pass `AbortController` into JP2 load path; abort when tile leaves `visibleSet`.
3. `dispose()` texture when evicted; keep `GeoLOD` mesh if re-entry is likely.

**Side note — dithering** ([NOTES.md](../../NOTES.md)): quantisation banding in contours may be encoder or shader sampling. Track as rendering experiment after load storm is fixed; try ordered dither in height sampling or contour threshold pass; unrelated to catalog shape but easier to evaluate when fewer tiles load at once.

## Phased delivery

### Phase 1 — Shard-scoped catalog load

- Extend manifest with optional `spatialIndex` root href (or keep flat shards but add bbox per shard in manifest — already have `extent` on `TileIndexShard`).
- Change `loadTerrainDatasetCatalog` to **lazy API**: `loadShardsInBounds(bounds)` instead of merging all shards.
- `makeTiles`: only instantiate `LazyTile` for tiles in initial bounds + margin; expand on camera move (debounced).

Acceptance: national manifest present on disk; app only fetches shards intersecting viewport.

### Phase 2 — Sparse scene graph

- Introduce `TileTree` in [TileLoaderUK.ts](../../src/geo/TileLoaderUK.ts); migrate `this.tiles` to tree iteration for debug counts.
- Remove eager `forEach` over full catalog.

Acceptance: object count in scene proportional to visible area, not England.

### Phase 3 — Abort + eviction bridge

- Wire abort into [jp2kloader.ts](../../src/openjpegjs/jp2kloader.ts) / `getTileMesh`.
- Soft GPU byte cap; evict oldest non-basemap textures.

Acceptance: zoom out cancels in-flight decodes; memory stable when panning across large extent.

### Phase 4 — TileLayerManager

- Full migration per [tile-layers.md](../tile-layers.md) § _Migration map_; `height.primary` channel owns load/dispose.

Acceptance: compression experiment uses channels; no module singleton; second renderer possible.

### Phase 5 — Hierarchical index on disk

- ~~Pipeline emits hierarchical index~~ — **done** for bounded cell ingest ([v2-pyramid-pipeline.md](v2-pyramid-pipeline.md)).
- **Remaining:** national multi-cell tree, frontend catalog ([§ Frontend rendering](#frontend-rendering-v2-datasets)), deprecate v1 full-shard download path.

## Metrics to track

| Metric | How |
|--------|-----|
| Shards fetched per session | network log |
| `LazyTile` / `TileNode` count | debug panel |
| In-flight JP2 decodes | counter |
| GPU bytes (textures) | sum `RasterPayload.bytes` |
| Time-to-first-frame after pan | stopwatch / perf mark |

## Open questions

- Shard size today (`shardSizeMetres` in manifest) vs optimal for HTTP — trade fewer large JSONs vs more parallel small ones?
- Should invisible tiles keep placeholder meshes for picking / track overlay alignment?
- Viewshed-driven prefetch: how many tiles beyond frustum to speculatively warm?

## Success criteria

- National dataset: startup does not download multi-GB index or create 10⁴+ scene nodes.
- Zoomed-out view: GPU memory and decode concurrency bounded; panning does not accumulate textures indefinitely.
- Zoomed in: leaf tiles use fine raster pyramid + high geometric `GeoLOD` where needed; zoomed out: coarse pyramid on branch nodes without decoding every leaf HTJ2K.
