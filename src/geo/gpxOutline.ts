import parseGPX from './GpxParser';

export type LatLon = { lat: number; lon: number };

export function gpxTrackPointsFromText(gpxText: string): LatLon[] {
    const gpx = parseGPX(gpxText);
    const tracks = gpx.tracks ?? gpx.routes;
    if (!tracks?.length) return [];
    return tracks[0].segments.flat().map((tp) => ({ lat: tp.lat, lon: tp.lon }));
}

export function decimatePoints(points: LatLon[], maxPoints = 180): LatLon[] {
    if (points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    return points.filter((_, i) => i % step === 0);
}

/** Normalised lat/lon polyline as an SVG path in pixel space (y down). */
export function latLonToSvgPath(
    points: LatLon[],
    width: number,
    height: number,
    padding = 3,
): string {
    if (points.length < 2) return '';
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const p of points) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
    }
    const spanLat = maxLat - minLat || 1e-6;
    const spanLon = maxLon - minLon || 1e-6;
    const innerW = width - 2 * padding;
    const innerH = height - 2 * padding;
    const scale = Math.min(innerW / spanLon, innerH / spanLat);
    const ox = padding + (innerW - spanLon * scale) / 2;
    const oy = padding + (innerH - spanLat * scale) / 2;

    let d = '';
    for (let i = 0; i < points.length; i++) {
        const x = ox + (points[i].lon - minLon) * scale;
        const y = oy + (maxLat - points[i].lat) * scale;
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d;
}

const thumbnailPathCache = new Map<string, string>();

export async function fetchGpxThumbnailPath(
    gpxUrl: string,
    width = 72,
    height = 52,
): Promise<string> {
    const cacheKey = `${gpxUrl}@${width}x${height}`;
    const cached = thumbnailPathCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const res = await fetch(gpxUrl);
    if (!res.ok) throw new Error(`GPX fetch failed: ${gpxUrl} (${res.status})`);
    const points = decimatePoints(gpxTrackPointsFromText(await res.text()));
    const path = latLonToSvgPath(points, width, height);
    thumbnailPathCache.set(cacheKey, path);
    return path;
}
