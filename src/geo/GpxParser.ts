import { Gpx, GpxMetadata, GpxTrackpoint } from "./gpxtypes";

const F = Number.parseFloat;

export default function parseGPX(source: string) : Gpx {
    const parser = new DOMParser();
    const xml = parser.parseFromString(source, 'text/html');

    const segsRaw = getEls(xml, 'trkseg');
    const tracks = segsRaw.length > 0 ? [{segments: segsRaw.map(trksegProcess)}] : undefined;
    
    const rteRaw = getEls(xml, 'rte');
    const routes = rteRaw.length > 0 ? [{segments: rteRaw.map(rteProcess)}] : undefined;
    const metadata = parseMetadata(xml);
    
    return {
        routes, tracks, metadata
    };
}

function parseMetadata(xml: Document) : GpxMetadata {
    const gpx = getFirstEl(xml, 'gpx')!;
    const creator = gpx.attributes.getNamedItem('creator')?.value;
    //const meta = getFirstEl(xml, 'metadata');
    const timeStr = getFirstEl(gpx, 'time')?.innerHTML; //might or might not be from metadata
    const name = getFirstEl(gpx, 'name')?.innerHTML; //might or might not be from metadata
    const time = timeStr ? new Date(timeStr) : undefined;
    return {creator, time, name}
}

function getFirstEl(xml: Element | Document, tagName: string) {
    return xml.getElementsByTagName(tagName).item(0);
}
function getEls(xml: Element | Document, tagName: string) {
    return [...xml.getElementsByTagName(tagName)];
}

function parsePoint(p: Element) {
    return {
        lat: F(p.attributes.getNamedItem('lat')!.value),
        lon: F(p.attributes.getNamedItem('lon')!.value),
        altitude: F(p.getElementsByTagName('ele')[0].innerHTML)
    }
}
function trksegProcess(trkseg: Element): GpxTrackpoint[] {
    //turn into a point[] with a lat/lon, time, ele

    //https://stackoverflow.com/questions/53441292/why-downleveliteration-is-not-on-by-default
    //was worried create-react-app might interfere, but it doesn't seem to so far:
    //something to check if this gives compiler error in future.
    const pointsRaw = getEls(trkseg, 'trkpt');
    const points: GpxTrackpoint[] = pointsRaw.map(p => {
        return {
            ...parsePoint(p),
            time: new Date(p.getElementsByTagName('time')[0].innerHTML)
        }
    });
    return points;
}

//TODO GPX parser to handle 'routes' vs tracks. 
// <rte>
// <name>King Alfreds Way 2020 Final Route</name>
// <rtept lat="51.0636310" lon="-1.3190900">
//   <ele>55.5</ele>
//   <name>Winchester - Westgate</name>
//   <desc>Route Starts at the Western gate of Winchester City, Close to the medieval Great Hall and site of the ancient Winchester Castle </desc>
// </rtept>
// <rtept lat="51.0636690" lon="-1.3196130">
//   <ele>59.1</ele>
// </rtept>
// <rtept lat="51.0648300" lon="-1.3204540">
//   <ele>66</ele>
// </rtept>
// </rte>
//Also, this particular file has a lot of interesting metadata in waypoints
//eg:
// <wpt lat="51.0636310" lon="-1.3190900">
//   <ele>55.5</ele>
//   <name>Winchester - Westgate</name>
//   <desc>Route Starts at the Western gate of Winchester City, Close to the medieval Great Hall and site of the ancient Winchester Castle </desc>
// </wpt>
function rteProcess(rte: Element): GpxTrackpoint[] {
    const pointsRaw = getEls(rte, 'rtept');
    const points: GpxTrackpoint[] = pointsRaw.map((p, i) => {
        const name = p.getElementsByTagName('name')[0]?.innerHTML;
        const description = p.getElementsByTagName('desc')[0]?.innerHTML;
        if (name) console.log(name, description);
        return {
            ...parsePoint(p),
            name,
            description,
            time: new Date(i)
        }
    });
    return points;
}