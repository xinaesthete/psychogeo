use std::collections::BTreeMap;
use std::convert::{TryFrom, TryInto};
use std::io::{Cursor, Read};

use delaunator::{triangulate, Point};
use js_sys::{Float32Array, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;
use zip::read::ZipArchive;

const SHAPE_TYPE_NULL: i32 = 0;
const SHAPE_TYPE_POINT: i32 = 1;
const SHAPE_TYPE_POLYLINE: i32 = 3;
const SHAPE_TYPE_POLYGON: i32 = 5;
const SHAPE_TYPE_MULTI_POINT: i32 = 8;
const SHAPE_TYPE_POINT_Z: i32 = 11;
const SHAPE_TYPE_POLYLINE_Z: i32 = 13;
const SHAPE_TYPE_POLYGON_Z: i32 = 15;
const SHAPE_TYPE_MULTI_POINT_Z: i32 = 18;

#[derive(Default)]
struct ShapefileMembers {
    shp: Option<Vec<u8>>,
    dbf: Option<Vec<u8>>,
}

#[derive(Clone)]
struct DbfField {
    name: String,
    offset: usize,
    length: usize,
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn triangulate_coordinates3d(points_xyz: &[f64]) -> Result<Object, JsValue> {
    build_geometry_object(points_xyz).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub fn triangulate_shp_zip(shp_zip: &[u8]) -> Result<Object, JsValue> {
    let points_xyz = parse_points_from_shp_zip(shp_zip).map_err(|error| JsValue::from_str(&error))?;
    build_geometry_object(&points_xyz).map_err(|error| JsValue::from_str(&error))
}

fn build_geometry_object(points_xyz: &[f64]) -> Result<Object, String> {
    if points_xyz.len() % 3 != 0 {
        return Err("expected xyz coordinates packed in groups of 3".to_owned());
    }

    let point_count = points_xyz.len() / 3;
    if point_count < 3 {
        return Err("need at least three points to triangulate".to_owned());
    }

    let mut planar_points = Vec::with_capacity(point_count);
    let mut coordinates = Vec::with_capacity(points_xyz.len());

    for point in points_xyz.chunks_exact(3) {
        planar_points.push(Point {
            x: point[0],
            y: point[1],
        });
        coordinates.push(point[0] as f32);
        coordinates.push(point[1] as f32);
        coordinates.push(point[2] as f32);
    }

    let triangulation = triangulate(&planar_points);
    let mut triangles = Vec::with_capacity(triangulation.triangles.len());
    for index in triangulation.triangles {
        let triangle_index = u32::try_from(index)
            .map_err(|_| "triangle index overflowed u32".to_owned())?;
        triangles.push(triangle_index);
    }

    let geometry = Object::new();
    Reflect::set(
        &geometry,
        &JsValue::from_str("coordinates"),
        &Float32Array::from(coordinates.as_slice()),
    )
    .map_err(js_error_to_string)?;
    Reflect::set(
        &geometry,
        &JsValue::from_str("triangles"),
        &Uint32Array::from(triangles.as_slice()),
    )
    .map_err(js_error_to_string)?;

    Ok(geometry)
}

fn parse_points_from_shp_zip(shp_zip: &[u8]) -> Result<Vec<f64>, String> {
    let members = read_shapefile_members(shp_zip)?;
    let mut points = Vec::new();
    for shapefile in members.into_values() {
        let Some(shp_bytes) = shapefile.shp.as_deref() else {
            continue;
        };
        let heights = shapefile
            .dbf
            .as_deref()
            .map(parse_dbf_prop_values)
            .transpose()?;
        append_points_from_shp(shp_bytes, heights.as_deref(), &mut points)?;
    }
    if points.is_empty() {
        return Err("no geometry found in shapefile archive".to_owned());
    }
    Ok(points)
}

fn read_shapefile_members(shp_zip: &[u8]) -> Result<BTreeMap<String, ShapefileMembers>, String> {
    let cursor = Cursor::new(shp_zip);
    let mut archive = ZipArchive::new(cursor).map_err(|error| format!("failed to open zip archive: {error}"))?;
    let mut members = BTreeMap::new();

    for entry_index in 0..archive.len() {
        let mut entry = archive
            .by_index(entry_index)
            .map_err(|error| format!("failed to read zip entry: {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let file_name = entry
            .name()
            .rsplit('/')
            .next()
            .unwrap_or(entry.name())
            .to_ascii_lowercase();
        let Some((stem, extension)) = file_name.rsplit_once('.') else {
            continue;
        };

        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to extract '{file_name}' from zip archive: {error}"))?;

        let shapefile = members.entry(stem.to_owned()).or_insert_with(ShapefileMembers::default);
        match extension {
            "shp" => shapefile.shp = Some(bytes),
            "dbf" => shapefile.dbf = Some(bytes),
            _ => {}
        }
    }

    Ok(members)
}

fn parse_dbf_prop_values(dbf_bytes: &[u8]) -> Result<Vec<Option<f64>>, String> {
    if dbf_bytes.len() < 32 {
        return Err("dbf header is truncated".to_owned());
    }

    let record_count = usize::try_from(read_u32_le(dbf_bytes, 4)?)
        .map_err(|_| "dbf record count overflowed usize".to_owned())?;
    let header_length = usize::from(read_u16_le(dbf_bytes, 8)?);
    let record_length = usize::from(read_u16_le(dbf_bytes, 10)?);

    if dbf_bytes.len() < header_length {
        return Err("dbf header length exceeds file size".to_owned());
    }

    let fields = parse_dbf_fields(dbf_bytes, header_length)?;
    let Some(prop_value_field) = fields
        .into_iter()
        .find(|field| field.name.eq_ignore_ascii_case("PROP_VALUE"))
    else {
        return Ok(vec![None; record_count]);
    };

    let records_end = header_length
        .checked_add(
            record_count
                .checked_mul(record_length)
                .ok_or_else(|| "dbf record section overflowed usize".to_owned())?,
        )
        .ok_or_else(|| "dbf record section overflowed usize".to_owned())?;
    if dbf_bytes.len() < records_end {
        return Err("dbf record section exceeds file size".to_owned());
    }

    let mut heights = Vec::with_capacity(record_count);
    for record_index in 0..record_count {
        let record_offset = header_length + record_index * record_length;
        let deleted_flag = *dbf_bytes
            .get(record_offset)
            .ok_or_else(|| "dbf record is truncated".to_owned())?;
        if deleted_flag == b'*' {
            heights.push(None);
            continue;
        }
        let value_start = record_offset
            .checked_add(prop_value_field.offset)
            .ok_or_else(|| "dbf field offset overflowed usize".to_owned())?;
        let raw_value = read_bytes(dbf_bytes, value_start, prop_value_field.length)?;
        heights.push(parse_dbf_numeric_value(raw_value));
    }

    Ok(heights)
}

fn parse_dbf_fields(dbf_bytes: &[u8], header_length: usize) -> Result<Vec<DbfField>, String> {
    let mut fields = Vec::new();
    let mut descriptor_offset = 32usize;
    let mut record_offset = 1usize;

    while descriptor_offset < header_length {
        let Some(marker) = dbf_bytes.get(descriptor_offset) else {
            break;
        };
        if *marker == 0x0D {
            break;
        }

        let descriptor = read_bytes(dbf_bytes, descriptor_offset, 32)?;
        let name = parse_dbf_field_name(&descriptor[..11]);
        let field_length = usize::from(descriptor[16]);

        fields.push(DbfField {
            name,
            offset: record_offset,
            length: field_length,
        });

        record_offset = record_offset
            .checked_add(field_length)
            .ok_or_else(|| "dbf field layout overflowed usize".to_owned())?;
        descriptor_offset = descriptor_offset
            .checked_add(32)
            .ok_or_else(|| "dbf header overflowed usize".to_owned())?;
    }

    Ok(fields)
}

fn parse_dbf_field_name(raw_name: &[u8]) -> String {
    let end = raw_name
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(raw_name.len());
    raw_name[..end]
        .iter()
        .copied()
        .filter(|byte| *byte != b' ')
        .map(char::from)
        .collect()
}

fn parse_dbf_numeric_value(raw_value: &[u8]) -> Option<f64> {
    let trimmed = std::str::from_utf8(raw_value).ok()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

fn append_points_from_shp(
    shp_bytes: &[u8],
    heights: Option<&[Option<f64>]>,
    sink: &mut Vec<f64>,
) -> Result<(), String> {
    if shp_bytes.len() < 100 {
        return Err("shp header is truncated".to_owned());
    }

    let mut record_offset = 100usize;
    let mut record_index = 0usize;
    while record_offset < shp_bytes.len() {
        let content_words = usize::try_from(read_i32_be(shp_bytes, record_offset + 4)?)
            .map_err(|_| "negative shp record length".to_owned())?;
        record_offset = record_offset
            .checked_add(8)
            .ok_or_else(|| "shp record header overflowed usize".to_owned())?;
        let content_bytes = content_words
            .checked_mul(2)
            .ok_or_else(|| "shp record length overflowed usize".to_owned())?;
        let content_end = record_offset
            .checked_add(content_bytes)
            .ok_or_else(|| "shp record length overflowed usize".to_owned())?;
        let content = read_bytes(shp_bytes, record_offset, content_bytes)?;
        let height = heights.and_then(|record_heights| record_heights.get(record_index)).copied().flatten();
        append_record_points(content, height, sink)?;
        record_offset = content_end;
        record_index = record_index
            .checked_add(1)
            .ok_or_else(|| "shp record count overflowed usize".to_owned())?;
    }

    Ok(())
}

fn append_record_points(content: &[u8], record_height: Option<f64>, sink: &mut Vec<f64>) -> Result<(), String> {
    let shape_type = read_i32_le(content, 0)?;
    match shape_type {
        SHAPE_TYPE_NULL => Ok(()),
        SHAPE_TYPE_POINT => append_point_record(content, record_height, sink),
        SHAPE_TYPE_POINT_Z => append_point_z_record(content, record_height, sink),
        SHAPE_TYPE_MULTI_POINT => append_multi_point_record(content, record_height, None, sink),
        SHAPE_TYPE_MULTI_POINT_Z => {
            let point_count = usize::try_from(read_i32_le(content, 36)?)
                .map_err(|_| "negative multipoint count".to_owned())?;
            let z_values = parse_z_array(content, 40 + point_count * 16, point_count)?;
            append_multi_point_record(content, record_height, Some(&z_values), sink)
        }
        SHAPE_TYPE_POLYLINE | SHAPE_TYPE_POLYGON => append_polyline_record(content, record_height, None, sink),
        SHAPE_TYPE_POLYLINE_Z | SHAPE_TYPE_POLYGON_Z => {
            let part_count = usize::try_from(read_i32_le(content, 36)?)
                .map_err(|_| "negative part count".to_owned())?;
            let point_count = usize::try_from(read_i32_le(content, 40)?)
                .map_err(|_| "negative point count".to_owned())?;
            let points_offset = 44 + part_count * 4;
            let z_values = parse_z_array(content, points_offset + point_count * 16, point_count)?;
            append_polyline_record(content, record_height, Some(&z_values), sink)
        }
        _ => Ok(()),
    }
}

fn append_point_record(content: &[u8], record_height: Option<f64>, sink: &mut Vec<f64>) -> Result<(), String> {
    let x = read_f64_le(content, 4)?;
    let y = read_f64_le(content, 12)?;
    let Some(height) = record_height else {
        return Ok(());
    };
    push_point(sink, x, y, height);
    Ok(())
}

fn append_point_z_record(content: &[u8], record_height: Option<f64>, sink: &mut Vec<f64>) -> Result<(), String> {
    let x = read_f64_le(content, 4)?;
    let y = read_f64_le(content, 12)?;
    let z = read_f64_le(content, 20)?;
    let Some(height) = record_height.or(Some(z)) else {
        return Ok(());
    };
    push_point(sink, x, y, height);
    Ok(())
}

fn append_multi_point_record(
    content: &[u8],
    record_height: Option<f64>,
    z_values: Option<&[f64]>,
    sink: &mut Vec<f64>,
) -> Result<(), String> {
    let point_count = usize::try_from(read_i32_le(content, 36)?)
        .map_err(|_| "negative multipoint count".to_owned())?;
    let points_offset = 40usize;
    for point_index in 0..point_count {
        let point_offset = points_offset + point_index * 16;
        let x = read_f64_le(content, point_offset)?;
        let y = read_f64_le(content, point_offset + 8)?;
        let Some(height) = record_height.or_else(|| z_values.and_then(|values| values.get(point_index)).copied()) else {
            continue;
        };
        push_point(sink, x, y, height);
    }
    Ok(())
}

fn append_polyline_record(
    content: &[u8],
    record_height: Option<f64>,
    z_values: Option<&[f64]>,
    sink: &mut Vec<f64>,
) -> Result<(), String> {
    let part_count = usize::try_from(read_i32_le(content, 36)?)
        .map_err(|_| "negative part count".to_owned())?;
    let point_count = usize::try_from(read_i32_le(content, 40)?)
        .map_err(|_| "negative point count".to_owned())?;
    let points_offset = 44 + part_count * 4;

    for point_index in 0..point_count {
        let point_offset = points_offset + point_index * 16;
        let x = read_f64_le(content, point_offset)?;
        let y = read_f64_le(content, point_offset + 8)?;
        let Some(height) = record_height.or_else(|| z_values.and_then(|values| values.get(point_index)).copied()) else {
            continue;
        };
        push_point(sink, x, y, height);
    }

    Ok(())
}

fn parse_z_array(content: &[u8], z_section_offset: usize, point_count: usize) -> Result<Vec<f64>, String> {
    let z_array_offset = z_section_offset
        .checked_add(16)
        .ok_or_else(|| "z section offset overflowed usize".to_owned())?;
    let mut z_values = Vec::with_capacity(point_count);
    for point_index in 0..point_count {
        z_values.push(read_f64_le(content, z_array_offset + point_index * 8)?);
    }
    Ok(z_values)
}

fn push_point(sink: &mut Vec<f64>, x: f64, y: f64, height: f64) {
    if x.is_finite() && y.is_finite() && height.is_finite() {
        sink.push(x);
        sink.push(y);
        sink.push(height);
    }
}

fn read_bytes<'a>(data: &'a [u8], offset: usize, length: usize) -> Result<&'a [u8], String> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| "byte range overflowed usize".to_owned())?;
    data.get(offset..end)
        .ok_or_else(|| "byte range exceeds file size".to_owned())
}

fn read_u16_le(data: &[u8], offset: usize) -> Result<u16, String> {
    let bytes: [u8; 2] = read_bytes(data, offset, 2)?
        .try_into()
        .map_err(|_| "failed to read u16".to_owned())?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32, String> {
    let bytes: [u8; 4] = read_bytes(data, offset, 4)?
        .try_into()
        .map_err(|_| "failed to read u32".to_owned())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_i32_le(data: &[u8], offset: usize) -> Result<i32, String> {
    let bytes: [u8; 4] = read_bytes(data, offset, 4)?
        .try_into()
        .map_err(|_| "failed to read i32".to_owned())?;
    Ok(i32::from_le_bytes(bytes))
}

fn read_i32_be(data: &[u8], offset: usize) -> Result<i32, String> {
    let bytes: [u8; 4] = read_bytes(data, offset, 4)?
        .try_into()
        .map_err(|_| "failed to read i32".to_owned())?;
    Ok(i32::from_be_bytes(bytes))
}

fn read_f64_le(data: &[u8], offset: usize) -> Result<f64, String> {
    let bytes: [u8; 8] = read_bytes(data, offset, 8)?
        .try_into()
        .map_err(|_| "failed to read f64".to_owned())?;
    Ok(f64::from_le_bytes(bytes))
}

fn js_error_to_string(error: JsValue) -> String {
    error
        .as_string()
        .unwrap_or_else(|| "javascript interop failed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::parse_points_from_shp_zip;

    #[test]
    fn parses_sample_os_archive() {
        let archive = include_bytes!("../../../public/data/su42_OST50CONT_20190530.zip");
        let points = parse_points_from_shp_zip(archive).expect("sample zip should parse");
        assert!(!points.is_empty());
        assert_eq!(points.len() % 3, 0);
    }
}
