import type { Track } from '../geo/TileLoaderUK';

/** API-shaped catalog row; backend would return this from GET /tracks. */
export type TrackCatalogItem = {
    id: string;
    title: string;
    summary?: string;
    region?: string;
    gpxUrl: string;
    colour: number;
    heightOffset: number;
};

const DEV_TRACK_CATALOG: TrackCatalogItem[] = [
    {
        id: 'stmawes',
        title: 'Gorran Haven → St Mawes',
        region: 'Cornwall',
        gpxUrl: 'gpx/Gorran_Haven_to_St_Mawe_s_tandem_solo_.gpx',
        heightOffset: 2,
        colour: 0x902020,
    },
    {
        id: 'stGiles',
        title: 'St Giles',
        region: 'Hampshire',
        gpxUrl: 'data/stgiles.gpx',
        heightOffset: 2,
        colour: 0x902020,
    },
    {
        id: 'palestine',
        title: 'Palestine',
        gpxUrl: 'data/palestine.gpx',
        heightOffset: 2,
        colour: 0x70f0f0,
    },
    {
        id: 'kaw',
        title: "King Alfred's Way",
        region: 'South England',
        gpxUrl: 'gpx/king_alfreds_way_2020_final_route.gpx',
        heightOffset: 20,
        colour: 0xf08050,
    },
    {
        id: 'stonehenge',
        title: 'Stonehenge circuit',
        gpxUrl: 'gpx/Where_the_Banshees_live_and_they_do_live_well.gpx',
        heightOffset: 2,
        colour: 0xf08050,
    },
    {
        id: 'bart',
        title: 'Kings Barton walk',
        region: 'Gloucester',
        gpxUrl: 'gpx/Kings-Barton-Walking-1-Apr-2021-at-17-55.gpx',
        heightOffset: 2,
        colour: 0x70f0f0,
    },
];

/** Stand-in for GET /tracks — replace with fetch('/api/tracks') later. */
export async function fetchTrackCatalog(): Promise<TrackCatalogItem[]> {
    return [...DEV_TRACK_CATALOG];
}

export function catalogItemToTrack(item: TrackCatalogItem): Track {
    return {
        url: item.gpxUrl,
        colour: item.colour,
        heightOffset: item.heightOffset,
    };
}

export function tracksFromCatalogSelection(
    catalog: TrackCatalogItem[],
    selectedIds: ReadonlySet<string>,
): Track[] {
    return catalog.filter((item) => selectedIds.has(item.id)).map(catalogItemToTrack);
}

export function colourToCss(colour: number): string {
    return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}
