// math
mat3 fromEuler(vec3 ang) {
	vec2 a1 = vec2(sin(ang.x),cos(ang.x));
    vec2 a2 = vec2(sin(ang.y),cos(ang.y));
    vec2 a3 = vec2(sin(ang.z),cos(ang.z));
    mat3 m;
    m[0] = vec3(a1.y*a3.y+a1.x*a2.x*a3.x,a1.y*a2.x*a3.x+a3.y*a1.x,-a2.y*a3.x);
	m[1] = vec3(-a2.y*a1.x,a1.y*a2.y,a2.x);
	m[2] = vec3(a3.y*a1.x*a2.x+a1.y*a3.x,a1.x*a3.x-a1.y*a3.y*a2.x,a2.y*a3.y);
	return m;
}
float hash( vec2 p ) {
	float h = dot(p,vec2(127.1,311.7));	
    return fract(sin(h)*43758.5453123);
}
float noise( in vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );	
	vec2 u = f*f*(3.0-2.0*f);
    return -1.0+2.0*mix( mix( hash( i + vec2(0.0,0.0) ), 
                     hash( i + vec2(1.0,0.0) ), u.x),
                mix( hash( i + vec2(0.0,1.0) ), 
                     hash( i + vec2(1.0,1.0) ), u.x), u.y);
}
float hash(vec3 p)  // replace this by something better
{
    p  = fract( p*0.3183099+.1 );
	p *= 17.0;
    return fract( p.x*p.y*p.z*(p.x+p.y+p.z) );
}
float noise( in vec3 x )
{
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f*f*(3.0-2.0*f);
	
    return mix(mix(mix( hash(i+vec3(0,0,0)), 
                        hash(i+vec3(1,0,0)),f.x),
                   mix( hash(i+vec3(0,1,0)), 
                        hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix( hash(i+vec3(0,0,1)), 
                        hash(i+vec3(1,0,1)),f.x),
                   mix( hash(i+vec3(0,1,1)), 
                        hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
const mat3 m = mat3( 0.00,  0.80,  0.60,
                    -0.80,  0.36, -0.48,
                    -0.60, -0.48,  0.64 );
float smoothNoise(in vec3 p) {
    float f = 0.0;
    f  = 0.5000*noise(p); p = m*p*2.01;
    f += 0.2500*noise(p); p = m*p*2.01;
    f += 0.1250*noise(p); p = m*p*2.01;
    f += 0.0625*noise(p); p = m*p*2.01;

    return f;
}
float bias(in float x, in float bias) {
    return x / ((((1./bias)-2.)*(1.-x))+1.);
}
float gain(in float x, in float g) {
    float g1 = bias(x*2., g) / 2.;
    float g2 = bias(x*2. - 1., 1. - g) / 2.+.5;
    if (x<0.5) {
        return g1;
    } else {
        return g2;
    }
    return mix(g1, g2, .5 + .5*sign(g-.5)); //not sure what's wrong
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = vec4(0.);
    vec2 uv = fragCoord / iResolution.xy;
    float d = 2.* 0.1 + length(.5-uv);
    float n2 = smoothNoise(vec3(uv*3.2, iTime * .015));
    vec3 ro = vec3(uv, (iTime*0.03) + n2*iTime*0.1*sin(iTime*.1)*pow(d, 0.3));
    float n = smoothNoise(ro*20.4);
    float v = gain(bias(n, n2 * .9 * (1.-d)), saturate(0.1 + 0.1*d));
    fragColor.rgb = vec3(v * vec3(1.,0.94,0.9));
    fragColor.w = 1.;
}
