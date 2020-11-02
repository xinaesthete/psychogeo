// Super simple raymarching example. Created by Reinder Nijhoff 2017
// PJT modified for figuring out stuff related to projection of point onto sphere (related to earth curvature)
// Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License.
// @reindernijhoff
// 
// https://www.shadertoy.com/view/4dSBz3
//
// This is the shader used as example in my ray march tutorial: https://www.shadertoy.com/view/4dSfRc
//
// Created for the Shadertoy Competition 2017 
//
#define PI 3.14159
float v(vec3 p);
float sphere( vec3 p, float r) {
    return length(p) - r;
}
float sdVerticalCapsule( vec3 p, float h, float r )
{
  p.y -= clamp( p.y, 0.0, h );
  return length( p ) - r;
}
vec3 rotateX(vec3 p, float theta) {
    mat3 m = mat3(cos(theta), -sin(theta), 0.,
                sin(theta), cos(theta), 0.,
                0., 0., 1.);
    return m * p;
}
vec3 rotateZ(vec3 p, float phi) {
    mat3 m = mat3(cos(phi), 0., sin(phi),
            0., 1., 0.,
            -sin(phi), 0., cos(phi));
    return m * p;
}
vec3 rotateY(vec3 p, float phi) {
    mat3 m = mat3(1., 0., 0,
            0., cos(phi), -sin(phi),
            0., sin(phi), cos(phi));
    return m * p;
}

float opSmoothUnion( float d1, float d2, float k ) {
    k = abs(k);
    float h = clamp( 0.5 + 0.5*(d2-d1)/k, 0.0, 1.0 );
    return mix( d2, d1, h ) - k*h*(1.0-h); 
}
float opRep( in vec3 p, in vec3 c )
{
    vec3 q = mod(p+0.5*c,c)-0.5*c;
    return v( q );
}
vec3 car2pol(in vec3 p) {
    float r = length(p);
    float lat = acos(p.z / r);
    float lon = acos(p.x / length(p.xy)) * sign(p.y);
    return vec3(r, lat, lon);
}
vec3 pol2car(in vec3 p) {
    float r = p.x;
    float lat = p.y;
    float lon = p.z;
    float x = r * sin(lat) * cos(lon);
    float y = r * sin(lat) * sin(lon);
    float z = r * cos(lat);
    return vec3(x, y, z);
}
float mirrorRepeat(in float x, in float l) {
    float v = 2.*l;
    return min(abs(mod(x, v)), abs(mod(v-x, v)));
}
float opSym( in vec3 p, in float r, in float n) {
    vec3 op = p;
    vec3 s = sign(p);
    //float theta = length(p.xy) / r;
    //float phi = atan(p.y, p.x) / r;
    p.y -= r;
    vec3 pol = car2pol(p);
    // pol.z += iTime;
    float theta = pol.z;
    float ang = 2.*PI/n;// 2.*PI / 3.;
    // theta = mod(theta, ang);
    theta = mirrorRepeat(theta + .5*ang, ang/2.);
    theta += ang;
    pol.z = -theta; //--- ??? ---
    float phi = pol.y;
    pol.y = mirrorRepeat(pol.y, 0.25*ang) + ang;

    pol.x = mirrorRepeat(pol.x, r*1.3);

    p = pol2car(pol);
    p.y += r;
    return v(mix(p, op, 0.5+0.5*sin(iTime*1.3)));
}
float sm(float d1, float d2) {
    return opSmoothUnion(d1, d2, 0.15);
}
float v(vec3 p) {
    float s = sphere(p, 0.1);
    float c = sdVerticalCapsule(p + vec3(0., 0.4, 0.), 0.5, 0.02);
    float c2 = sdVerticalCapsule(rotateX(p, PI/2.), 0.4, 0.01);
    c = sm(c, c2);
    return sm(c, s);
}
//
// Distance field function for the scene.
//
float map(vec3 p) {
    float t = iTime;
    float r = 1.3;
    
    p -= vec3(0, 1., -4.);
    p*= -1.;
    
    float d = opSym(p, r, 4.5 + 0.5*sin(iTime));
    // d = sm(opSym(p+vec3(0., -.5, 0.), r/2., 4.), d);
    p += vec3(0., -r, 0.);
    d = mix(d, sphere(p, r*0.9), pow(0.5 + 0.5*sin(t*.3), 10.));
    return d;
}

float mapX(vec3 p) {
    float t = iTime;
    float r = 1.3 + 0.2*sin(t*2.);
    vec3 p0 = vec3(0., 0., 0.);
    vec3 p1;// = vec3(1.6+sin(t), 0., 1.4);
    p1.x = r + sin(t*2.);
    p1.y = 0.;// + 0.2*sin(t*5.);
    p1.z = 0.+sin(t*1.);
    vec2 dp = p1.xz - p0.xz;
    float theta = length(dp) / r;
    float phi = atan(dp.y, dp.x) / r;
    // float theta = length(p1.xz) / r;
    // float phi = atan(p1.z, p1.x) / r;

    p -= vec3(0, 0, -4.);
    p *= -1.;
    float d = v(p+p0);
    d = sm(d, opSym(p+p1, r, 6.));
    p += vec3(0., -r, 0.);
    d = sm(d, sphere(p, r));
    p = rotateX(p, PI - theta);
    p = rotateY(p, -phi);
    d = sm(d, v(rotateX(p - vec3(0., r+p1.y, 0.), PI)));
    return d;
}

//
// Calculate the normal by taking the central differences on the distance field.
//
vec3 calcNormal(in vec3 p) {
    vec2 e = vec2(1.0, -1.0) * 0.0005;
    return normalize(
        e.xyy * map(p + e.xyy) +
        e.yyx * map(p + e.yyx) +
        e.yxy * map(p + e.yxy) +
        e.xxx * map(p + e.xxx));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec3 ro = vec3(0, 0, 1);                           // ray origin

    vec2 q = (fragCoord.xy - .5 * iResolution.xy ) / iResolution.y;
    vec3 rd = normalize(vec3(q, 0.) - ro);             // ray direction for fragCoord.xy

    // March the distance field until a surface is hit.
    float h, t = 1.;
    for (int i = 0; i < 256; i++) {
        h = map(ro + rd * t);
        t += h;
        if (h < 0.01) break;
    }

    if (h < 0.01) {
        vec3 p = ro + rd * t;
        vec3 normal = calcNormal(p);
        vec3 light = vec3(0, 2., 0);
        
        // Calculate diffuse lighting by taking the dot product of 
        // the light direction (light-p) and the normal.
        float dif = clamp(dot(normal, normalize(light - p)), 0., 1.);
		
        // Multiply by light intensity (5) and divide by the square
        // of the distance to the light.
        dif *= 5. / dot(light - p, light - p);
        
        
        fragColor = vec4(vec3(pow(dif, 0.4545)), 1);     // Gamma correction
    } else {
        fragColor = vec4(0, 0, 0, 1);
    }
}