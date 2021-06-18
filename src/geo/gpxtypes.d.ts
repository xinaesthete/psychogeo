// may look a lot like 'practical-geo-to-js' (indeed, started out by pasting some code)
// but I'd rather not add a dependency
// and also felt like changing things as soon as I looked at the code.

export interface GpxWaypoint {
    lat: number;
    lon: number;
    time?: Date;
    name?: string;
    description?: string;
    symbol?: string;
    altitude?: number;
}

export interface GpxTrackpoint {
    lat: number;
    lon: number;
    time?: Date;
    altitude?: number;
    //adding name & description here... although actually it's on 'GpxRoutepoint' <rtept> that I'm seeing them.
    name?: string;
    description?: string;
    speed?: number;
    cadence?: number;
    heartRate?: number;
}

export interface GpxTrack {
    name?: string;
    // trackpoints: GpxTrackpoint[];
    segments: GpxTrackpoint[][];
}

export interface GpxMetadata {
    name?: string;
    description?: string;
    creator?: string;
    time?: Date;
}

export interface Gpx {
    metadata: GpxMetadata;
    waypoints?: GpxWaypoint[];
    tracks?: GpxTrack[];
    routes?: GpxTrack[];
}

export interface ParsedGpx {
    gpx: {
        $: {
            creator: string;
            [propName: string]: any;
        };
        metadata: any[];
        trk: any[];
        wpt: any[];
    };
}
