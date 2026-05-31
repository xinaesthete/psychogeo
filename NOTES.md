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

Dealing with missing/unclean data. Quite often sections of a recording are dropped, or there is noise when GPS signal is low etc. I'd like to have some utilities for data-cleaning, adding missing data etc.

## Different interfaces / uses...

I want to have somewhat serviceable means of using this as a somewhat useful tool while out hiking/cycling: improved mobile UI, less heavy on the battery, clear viewshed representation (with correction for Earth curvature etc).

I'd like to be able to generally have other experimental graphics and music computer-art type things embedded in this kind of geographic context... so thinking about how we make that work. Things I might publish as webpages vs things I run locally (do I want to further develop Electron app that lets me manage local data etc?).

## Other environmental datasets etc, FOI request considerations...

[CASI Multispectral Imagery](https://environment.data.gov.uk/dataset/18713fc4-c040-4b79-9c46-4738ffbe3c3d)

> Compact Airborne Spectrographic Imager is a multispectral pushbroom system that acquires data in visible and near infrared (VNIR) light. Unlike camera systems that generally acquire data in three (red, green, blue) or four (red, green, blue and near infra-red) bands, the CASI splits light into several discrete bands, up to 288, although approximately 20 are more normally captured.
> It is capable of collecting data in discrete areas of the electromagnetic spectrum and can target key wavelengths that allow information about ground characteristics and ground cover type to be inferred. For example, the CASI can target the precise wavelengths of chlorophyll absorption or the algae fluorescence peak.

Also "CASI and LIDAR Habitat Map" (downloaded to my local GIS folder as of writing, polygon shapefile showing relevant habitat classes, not the CASI data).

Very MDV related... generally thinking about things like UMAP of tiles/land parcels etc. Potential use-case for some kind of MDV extension/plugin. Might think about whether and how to publish MDV as an npm thing. Should be possible to `npm i mdv`, `import ChartManager from 'mdv'`, register some custom chart-types and `DataLoader`... maybe even a different layout manager.