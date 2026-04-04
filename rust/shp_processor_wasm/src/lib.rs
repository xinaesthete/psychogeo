use std::convert::TryFrom;

use delaunator::{triangulate, Point};
use js_sys::{Float32Array, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn triangulate_coordinates3d(points_xyz: &[f64]) -> Result<Object, JsValue> {
    if points_xyz.len() % 3 != 0 {
        return Err(JsValue::from_str("expected xyz coordinates packed in groups of 3"));
    }

    let point_count = points_xyz.len() / 3;
    if point_count < 3 {
        return Err(JsValue::from_str("need at least three points to triangulate"));
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
            .map_err(|_| JsValue::from_str("triangle index overflowed u32"))?;
        triangles.push(triangle_index);
    }

    let geometry = Object::new();
    Reflect::set(
        &geometry,
        &JsValue::from_str("coordinates"),
        &Float32Array::from(coordinates.as_slice()),
    )?;
    Reflect::set(
        &geometry,
        &JsValue::from_str("triangles"),
        &Uint32Array::from(triangles.as_slice()),
    )?;

    Ok(geometry)
}
