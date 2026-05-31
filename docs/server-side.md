# Server-side roadmap

How data gets prepared, served, and persisted for psychogeo. Covers:

- Offline data-processing pipelines and a dev UI to control them.
- A runtime backend for catalog-style data (tracks first).
- An honest evaluation of React Server Components vs simpler alternatives.
- Future storage-format evolution (Zarr).
- A sequenced migration order.

This doc is a contract, not an implementation. No code lands in this PR.

## Related docs

- [docs/future-terrain.md](future-terrain.md) — overall direction.
- [docs/tile-layers.md](tile-layers.md) — the in-browser side of the same data lifecycle; channel payloads come from artefacts that the pipelines below produce.
- [docs/compression-experiment.md](compression-experiment.md) — the experiment that re-encodes pipeline outputs at runtime.

## 1. Where data lives today

- **Dev proxy.** [vite.config.mjs](../vite.config.mjs) routes `/tile`, `/ltile`, `/ttile`, `/gpx`, `/os`, `/ping` to `localhost:8082` — a local data proxy serving pre-processed files. No production backend exists.
- **Pre-processing scripts.** [scripts/](../scripts/) holds DEFRA processing helpers — `defra_test.js`, `defra_util.js`, `transcodeNormalise.js`, `gebco_tiff2jph.js`, `patchJan22.js`. Entry point is `pnpm --dir scripts defra`. There is no dev UI; results are visible only by running and inspecting the filesystem.
- **In-browser ingestion (not server-side).** SHP triangulation runs in [rust/shp_processor_wasm](../rust/shp_processor_wasm) WASM in-browser. Worth noting because the existing Rust crate is a precedent if a Rust backend is chosen later.
- **Track catalog.** `fetchTrackCatalog()` in [src/tracks/trackCatalog.ts](../src/tracks/trackCatalog.ts) returns a hardcoded `DEV_TRACK_CATALOG`. The comment on it reads "Stand-in for GET /tracks — replace with `fetch('/api/tracks')` later." That is the first real backend endpoint.

Result: today the only "server" is a dumb static-file proxy. Anything dynamic (catalog filtering, ingestion triggering, manifest queries) needs a real backend.

## 2. Data-processing pipelines (catalogue)

Pipelines that will exist, in roughly the order they will be needed:

| Pipeline | Inputs | Outputs |
|----------|--------|---------|
| **DSM ingest** | DEFRA download | OSGB-cropped 1 m HTJ2K tiles + catalog JSON (already partly here in `scripts/`). |
| **DTM ingest** | DEFRA 10 m DTM download | Cropped 10 m HTJ2K tiles + catalog JSON. |
| **Basemap bake** | Source raster (e.g. coarse DSM, OS Terr50 raster) | Chunk grid with apron + per-chunk HTJ2K + manifest JSON. Spec in [tile-layers.md](tile-layers.md) § _Basemap morph_. |
| **Aux raster bake** | First-return − last-return DSM and similar (see [future-terrain.md](future-terrain.md) § _Auxiliary height channels_) | Coarser pre-baked raster + sidecar metadata. |
| **Track catalog ingest** | GPX files | Simplified geometry + spatial index + metadata records. |
| **Photo / aerial ingest** (future) | Orthophoto sources | Tiled + projected to OSGB. |

Common shape for every pipeline:

- **Inputs** described as a JSON declaration (paths, URLs, parameters).
- **Outputs** to a versioned directory plus a manifest JSON that describes contents and schema.
- **Idempotency / versioning** — re-runs with the same inputs produce stable artefact identifiers; outputs are immutable per version.
- **Progress reporting** — structured JSON-line events on stdout so dev UI can render progress without scraping.
- **Validation** — sanity-check outputs against the manifest schema before marking a version as ready.

A pipeline runner module owns the lifecycle (start / stop / status / promote) and a small registry of these definitions. Today's [scripts/](../scripts/) is the implementation seed; the runner formalises it.

## 3. Dev UI for pipelines

The dev UI is admin-only, never in the production bundle. Surface options compared:

| Option | Pros | Cons |
|--------|------|------|
| **Same app, dev-only route** (`/dev/pipelines`) gated on `import.meta.env.DEV` or admin auth | Discoverable; shares Leva chrome, components, and styles; one mental model | Pollutes the main app's import graph with pipeline-runner code |
| **Separate small app** colocated in repo, separate Vite root | Clean separation; pipeline runner does not bloat the main bundle | Discoverability worse; two surfaces to maintain |

**Recommendation:** start with the dev-only route inside the main app. The surface is small (one screen, maybe two) and tree-shaking should keep production bundles clean if the route is import.meta.env-gated. Reconsider once the dev UI has more than three screens.

Functionality the dev UI needs to expose:

- **Trigger** — start a pipeline with parameters (form generated from the pipeline definition's inputs JSON).
- **Monitor** — live progress, stderr / stdout, eventual artefact location. Live progress wants either polling or streaming (SSE / WebSocket). RSC streaming is one option (see § 5).
- **Inspect** — browse generated catalog entries, preview basemap chunks, see encoded sizes vs source.
- **Promote** — mark a version as "current" so the running app picks it up. Promotion is the only mutating operation that touches what the production frontend sees, so it deserves explicit confirmation.

## 4. Runtime backend

What a real backend serves:

- **`GET /tracks`** — the track catalog. Already implied by the existing stub in [src/tracks/trackCatalog.ts](../src/tracks/trackCatalog.ts).
- **Tile / chunk manifests** — JSON listings that the frontend's tile catalog and basemap chunk grid read at startup.
- **Aux channels metadata** — per-tile listing of available auxiliary rasters, their format and sizing.
- **Future authoring endpoints** — saving graph layouts, annotations, named places, viewshed parameters. These need persistence beyond the filesystem.

Binary tile data itself does not strictly need a backend — static / CDN works. The backend exists for queries, indexing, persistence, and the pipeline-runner control plane in § 3.

Candidate stacks:

| Stack | Why consider | Why not |
|-------|--------------|---------|
| **Node + Hono / Fastify** | Matches the frontend language; unlocks RSC if chosen later | One more language only if Rust is rejected |
| **Rust** | Shares crates with [rust/shp_processor_wasm](../rust/shp_processor_wasm) — pipelines and backend could share code | RSC ecosystem is JS-side, so a Rust backend forecloses the RSC option |
| **Python** | Strong scientific / geospatial library set | Adds a third language; only justified if pipelines lean heavily on Python tools |

**Recommendation:** Node + Hono. Smallest delta from the existing toolchain. Keeps the RSC option open. Rust stays the natural choice for the pipeline runner's heavy lifting (it already is, in WASM form), wrapped by the Node backend.

## 5. React Server Components evaluation

The user is "considering RSC". Honest evaluation rather than yes/no:

### 5.1 Where RSC fits well

- **Track catalog browser.** Render the list server-side; minimal JS to the client. Filters and search are forms posting to the same routes.
- **Pipeline dev UI.** Forms + server actions for trigger / inspect / promote. Streaming for live progress comes free in RSC's model.

### 5.2 Where RSC does _not_ fit

- The 3D canvas, Leva controls, and everything in [src/geo/](../src/geo/) stay client components. They depend on WebGL, requestAnimationFrame, and module-level mutation that has no SSR analogue. RSC and CSR have to coexist in the app, which is fine but worth being clear about.

### 5.3 What RSC needs

A bundler / runtime that supports it. Today's stack is Vite + plugins; vanilla Vite does not support RSC. Realistic paths:

- **Next.js** — native RSC. The migration would dominate the project, replacing Vite, the dev server, the build, and React-Router-equivalent. Overkill for psychogeo's size.
- **Waku** — minimal RSC framework, Vite-native, much smaller surface than Next. Less mature but plausible for an internal dev UI.
- **Roll-your-own RSC plugin for Vite** — high friction, fragile. Not recommended.

### 5.4 Alternatives without RSC

| Option | What it is | When to pick it |
|--------|------------|-----------------|
| **REST + React Query** | Plain HTTP endpoints, cached / refetched in client | Minimal lock-in; perfect for a small catalog endpoint |
| **tRPC + React Query** | Strongly typed RPC over HTTP | When the schema sprawl across the frontend becomes a problem |
| **Astro + Vite islands** | SSR for catalog-style pages; the 3D canvas is an island | Good middle ground if you want SSR-rendered HTML without the RSC ceremony |

### 5.5 Recommendation

Do **not** migrate the existing app to Next.js. Two paths from here, decide later:

- **Start small with REST + React Query** for `GET /tracks`. Zero new infrastructure. Revisit RSC after the backend has stable shape and the dev UI has more than one screen.
- **Prototype Waku on the dev UI first** if RSC is the desired direction. The dev UI is contained, isolated from the main app, and a reasonable place to validate the RSC ergonomics before committing to it more widely.

Either way, the 3D canvas does not need to change.

## 6. Storage format evolution (Zarr evaluation)

Future direction: move rasters out of per-file HTJ2K + JSON-catalog and into a **Zarr** store. Document the evaluation criteria now so the next phase knows what to check. **Not in scope of this PR**; this section is a checklist for when storage migration becomes the priority.

### 6.1 Apron / overlap fit

Native Zarr chunks are non-overlapping. The basemap apron mechanic in [tile-layers.md](tile-layers.md) § _Basemap morph_ has to reconcile with that. Options to compare:

- **Bake apron into chunk size.** Chunks larger than rendering tiles; renderer samples interior + apron from the same chunk. Simplest, wastes pixels.
- **Side-car arrays for overlap regions.** Extra Zarr arrays alongside the primary tile array, holding the apron pixels. Doubles the storage indirection but keeps the primary array clean.
- **Runtime neighbour fetch.** Fetch up to four adjacent chunks for edge sampling. No baked overlap, but per-frame bandwidth cost.

### 6.2 Codec choice

HTJ2K is not a standard Zarr codec. Options:

- **Custom Zarr v3 codec adapter** wrapping the existing OpenJPH WASM in [src/openjpegjs/jp2kloader.ts](../src/openjpegjs/jp2kloader.ts). Heaviest engineering. Preserves format investment and keeps the compression experiment ([compression-experiment.md](compression-experiment.md)) honest.
- **Switch to a Zarr-native codec** (zstd, blosc). Simpler. May regress compression ratio for height rasters and the current compression experiment loses its subject.
- **Hybrid.** HTJ2K for height (where the experiment lives), zstd / blosc for aux and vector channels.

### 6.3 Multi-scale / LOD

OME-Zarr defines a multiscale pyramid layout that aligns with the 12-level LOD model in [src/geo/LodUtils.ts](../src/geo/LodUtils.ts). Worth adopting rather than reinventing — it gives a standard place to put resolution levels and their metadata.

### 6.4 Sharding (Zarr v3)

Shard small chunks together to reduce file count and HTTP-request overhead. Important when serving from static hosting where round-trip cost dominates. Evaluate shard size against typical viewport tile-set size from the working-set budget in [tile-layers.md](tile-layers.md) § _Visibility model_.

### 6.5 Browser library

- **zarrita.js** — lighter, Zarr v3-first. Custom-codec support is the key thing to evaluate.
- **zarr.js** — older, broader feature set, larger.

Pick on bundle size and custom-codec hooks. Plain HTTP range requests work for both.

### 6.6 Server delivery

- **Direct static hosting** of a Zarr store on a CDN. Works because Zarr is filesystem-shaped. Cheapest.
- **Thin server adding query semantics** (e.g. tensorstore, xpublish, FastAPI). Useful if subsetting or projection on the server side becomes valuable.

Aligns with the backend choice in § 4. A Node + Hono backend can serve Zarr as static files trivially; a Rust backend can do the same plus heavier lifting.

### 6.7 Metadata compatibility

Today's `dsm_catalog.json` and `10m_dtm_catalog.json` (loaded in [src/geo/TileLoaderUK.ts](../src/geo/TileLoaderUK.ts)) need translation to Zarr group attributes (`.zattrs`). Decide whether to keep both sources (catalog JSON for app metadata + Zarr for binary) or fold catalog into Zarr `.zattrs`.

### 6.8 Compression experiment continuity

If HTJ2K stays via a custom codec, the runtime recode (q slider) keeps the same character. If a different codec is adopted, the experiment becomes "evaluating _that_ codec's quality knobs" — call this out explicitly so it is not a silent regression. The compression experiment is currently a feature of the format, not the renderer.

## 7. Migration order

Sequenced recommendation. Each item is sized for a single PR or small chain.

1. **Stand up a small Node + Hono backend** with one endpoint: `GET /tracks` returning JSON. Wire `fetchTrackCatalog()` in [src/tracks/trackCatalog.ts](../src/tracks/trackCatalog.ts) to call it. Use REST + React Query on the frontend. Smallest possible first step that proves the server / client wiring.
2. **Move pipeline scripts under [scripts/pipelines/](../scripts/pipelines/)** with a shared progress / manifest convention. No new backend dependency.
3. **Add `/dev/pipelines` dev-only route** in the main app — read-only first (list pipelines, last-run, artefacts). Trigger / promote later.
4. **Re-evaluate RSC vs REST** once the backend has stable surface and the dev UI has more than one screen. Decision is reversible without a flag day.
5. **Run the Zarr evaluation in § 6 against a representative pipeline** — the basemap bake is a good first target since it is greenfield (no legacy artefacts to migrate). If Zarr wins, migrate the basemap channel first, leave the per-tile HTJ2K alone until the experiment is stable on the new substrate.

No code in this PR.
