## Texture recompression frontend

As of this writing, pipeline is incorrect for `float32` data i.e. the "defra10mDTMLayer".

I'm not convinced that the model is ideal, it can still get stuck making no progress sometimes...

Planning to make a DEFRA FOI request for full extent of this data, then make a more usable data-structure and pipeline for tile catalog etc. Would like to look into zarr but would need some effort to use the codec I want, and also I'm thinking about having some tile overlap so we can blend over seams... so maybe I stay somewhat bespoke.

Anticipating have a highly compressed layer that can be loaded cheaply, and then morphing to reasonable quality as it's loaded in (thinking about mobile use). May also use a super-compressed version as a proxy for representing terra-incognita.

Need to repeat recompression experiments based on starting with actual lossless data. Note that the baseline I'm currently working with exhibits some artefacts with contour rendering in some places, even if it's otherwise reasonable.

## Hosting / backend

Think about getting tile-data into a form that I could put online somewhere.

May be able to just use S3 for that.

I'll likely be wanting some amount of backend db etc. Intend to experiment with RSC for some amount of backend stuff; potentially via some Vite plugin, need to determine how viable this is vs next.js etc

Maybe get a VPS account for this? Contabo? https://www.kuroit.com/?

If I think I'm going to want such a thing, probably worth container-ising and making sure it'd be easy to migrate.

## Parameter state & GUI

I want to have a "Mutator"-ish model with a consistent nice GUI for this stuff. Think about making a library with UI for tweaking based on MDV "Settings Dialog" (but not driven by the same descriptors; could be zod-oriented?)... but also with mutator (interactive-genetic-algorithm) type functionality.

Concrete friction point; I wanted to change the default for `heightBlend` and hit about 4 different places where some state is initialising something a bit like that.

## Track catalog

I probably want to make a Strava API integration partly because this is where I routinely record tracks.

I'd also potentially rather not be using that anyway. Might make it able to record directly in the app and import from other sources (maybe push to Strava).

## Different interfaces / uses...

I want to have somewhat serviceable means of using this as a somewhat useful tool while out hiking/cycling: improved mobile UI, less heavy on the battery, clear viewshed representation (with correction for Earth curvature etc).

I'd like to be able to generally have other experimental graphics and music computer-art type things embedded in this kind of geographic context... so thinking about how we make that work.

