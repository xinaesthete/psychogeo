# TerraCognita - Experimental Geographical Visualisations

This is a personal project that I work on from time to time, there are various different directions in which I would like to take this in future - some more practical and others more artistic (I hope with some value in hybrid forms and symbiosis between the two).

In its current form, it is somewhat demanding of the computer it runs on to render the graphics, which are based on high-resolution digital surface models. The data it uses is based on freely available sources from DEFRA (currently only covering a small area around Winchester as it requires laborious manual downloading followed by post-processing to make it suitable for rendering) and Ordnance Survey. You'd probably need to talk to me to get it set up (although I should make a public website, with less demanding graphic modes, at some point soon).

## Development
This repo now uses `pnpm` and includes an in-repo Rust/WASM worker build.

### Tooling

You will need:

- Node.js `>=22.12.0`
- `pnpm@9.4.0` (Corepack is the easiest way to manage this)
- Rust `stable` via `rustup`
- the `wasm32-unknown-unknown` Rust target
- `wasm-pack`

The Rust crate at `rust/shp_processor_wasm` includes a `rust-toolchain.toml` pinned to `stable`, so you do not need to guess which Rust channel to use.

Install the required tooling with:

```bash
corepack enable
corepack prepare pnpm@9.4.0 --activate

rustup toolchain install stable
rustup target add wasm32-unknown-unknown --toolchain stable

cargo install wasm-pack
```

Optional, but useful if you work directly with generated bindings outside the normal `pnpm` scripts:

```bash
cargo install wasm-bindgen-cli
```

Then install project dependencies and start development:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts both the local data proxy and the Vite frontend, and now rebuilds the Rust worker in release mode first so the app behaves closer to production. If you only want one side of that setup, use `pnpm dev:proxy` or `pnpm dev:web`. If you want a quicker Rust rebuild while actively iterating on the worker, use `pnpm dev:fast`.

The helper scripts in `scripts/package.json` are part of the same workspace, so you can run them directly from that folder:

```bash
pnpm --dir scripts test
pnpm --dir scripts defra
```

## Animated contours
Simple adaptation of the rendering that reveals features of the landscape in a unique and interesting way:

![animated contours of watermeadows in Winchester](psygeoloop1-q15.webp)

In this animation you can see distinctive patterns from sinuous rolling hills fractured by the long and deep scar of a motorway, watermeadows with sprawling fractal tributuries, rectilinear patterns in ploughed fields, woodland, housing, hedgerows...

This type of rendering could be incorporated in a subtler form to a more traditional and recognisable form of map.

## Viewshed
This is a common feature of specialist GIS software, but one that I think could have much more mainstream interest if it were properly presented.

The current implementation is able to follow a path recorded as a `GPX` tracklog, using a shadow-casting light source to visualise what would be visible along that journey. The feature needs some development, but should compare favourably to other implementations (as well as having other novel additions and applications that I have in mind). With a fair wind of accurate GPS data behind it, the combination of high-res heightfield and realtime viewshed analysis could allow depiction of features such as the moment a view opens through a gap in a hedgerow.

![st giles hill viewshed](viewshed.webp)

This visualisation is currently rather glitchy particularly as a result of using the elevation data as recorded in a `GPX` file, which is highly inaccurate; I should base it on the height of the ground plus some offset. The quality of GPS data will still be a limiting factor, unfortunately.

## SHP WASM worker

The SHP triangulation worker now lives in-repo as a Rust/WASM crate under `rust/shp_processor_wasm` and is built automatically by the main frontend scripts.

After the tooling above is installed:

- `pnpm dev` to rebuild the WASM crate in release mode, start the local proxy on `localhost:8082`, and then start Vite on `localhost:3000`
- `pnpm dev:fast` to use a Rust `--dev` wasm build for a quicker worker rebuild/startup loop
- `pnpm build` to rebuild the WASM crate in release mode before producing `dist`
- `pnpm dev:web` if you only want the Vite frontend and already have the proxy running
- `pnpm dev:proxy` if you only want the local data proxy
- `pnpm run build:shp-wasm:dev` if you only want to refresh the worker package after changing the Rust source
- `pnpm run bench:shp` to run the JS-vs-Rust benchmark harness kept in `scripts/benchmark-shp.mjs` after rebuilding the wasm worker in release mode

The worker itself is bundled from `src/geo/shpWorker.ts`, so there is no longer any need to manually copy generated `.wasm` files into `public`.

The benchmark script still uses JS parsing/triangulation dependencies for comparison, but those are development-only and are not part of the frontend runtime bundle.
The benchmark command forces a release wasm rebuild first, so the Rust results do not depend on whether `pnpm dev` happened to leave a `--dev` artifact in `rust/shp_processor_wasm/pkg`.

### Verification

There is currently no CI for this repo. That is not a blocker for working on the SHP/WASM path now that the build is scripted, but it does mean local verification matters.

Before pushing changes that touch the worker or its build chain, run:

```bash
pnpm build
cargo test --manifest-path rust/shp_processor_wasm/Cargo.toml
```

The first Rust build after dependency changes may need network access so Cargo can download crates.
