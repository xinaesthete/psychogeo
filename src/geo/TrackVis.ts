import * as THREE from 'three'
import { convertWgsToOSGB, EastNorth } from './Coordinates'
import { GpxTrackpoint } from './gpxtypes';

export async function loadGpxGeometry(url: string, origin: EastNorth) {
    const data = await fetch(url);
    const track = parseGPX(await data.text());
    
    const pos = track.flatMap(tp => {
        const lat = tp.lat, lon = tp.lon;
        const en = convertWgsToOSGB({lat, lon});
        //const v = new THREE.Vector3(en.east - origin.east, en.north - origin.north, tp.altitude)
        return [en.east - origin.east, en.north - origin.north, tp.altitude || 0];
    });
    const s = track[0].time!.getTime();
    const time = track.map(tp => s - tp.time!.getTime() || 0);
    const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3);
    const timeAttr = new THREE.BufferAttribute(new Float32Array(time), 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', posAttr);
    geo.setAttribute('time', timeAttr);
    const lineGeo = new THREE.LineSegments(geo);
    return lineGeo;
}


const F = Number.parseFloat;

function parseGPX(source: string) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(source, 'text/html');
    // const eles: number[] = [...xml.getElementsByTagName('ele')].map(e => F(e.innerHTML));

    const segsRaw = [...xml.getElementsByTagName('trkseg')];
    const segsParsed = segsRaw.map(trksegProcess)[0];
    // const minLat = Math.min(...segsParsed.map(s => s.lat));
    // const minLon = Math.min(...segsParsed.map(s => s.lon));
    // const maxLat = Math.max(...segsParsed.map(s => s.lat));
    // const maxLon = Math.max(...segsParsed.map(s => s.lon));
    
    return segsParsed;
}

function trksegProcess(trkseg: Element): GpxTrackpoint[] {
    //turn into a point[] with a lat/lon, time, ele

    //https://stackoverflow.com/questions/53441292/why-downleveliteration-is-not-on-by-default
    const pointsRaw = [...trkseg.getElementsByTagName('trkpt')];
    const points: GpxTrackpoint[] = pointsRaw.map(p => {
        const lat = F(p.attributes.getNamedItem('lat')!.value);
        const lon = F(p.attributes.getNamedItem('lon')!.value);
        return {
            lat: F(p.attributes.getNamedItem('lat')!.value),
            lon: F(p.attributes.getNamedItem('lon')!.value),
            altitude: F(p.getElementsByTagName('ele')[0].innerHTML),
            time: new Date(p.getElementsByTagName('time')[0].innerHTML)
        }
    });
    return points;
}

