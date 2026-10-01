/** Crown-local lighting shared by select and glyph programs. CPU twins: glyphs/select.ts. */
import { CLUMPS, CROWN_LIGHT, CROWN_RAMP, CROWN_TINTS } from '../glyphs/select';
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
export const foliageGlsl = /* glsl */ `
uniform vec3 u_crownSun;
uniform bool u_crownNight;
float hashByte(uint h, uint shift) { return float((h >> shift) & 255u) / 255.0; }

// Height and analytic derivatives of a seeded leaf cluster field.
vec3 crownNoiseGradient(vec2 p, uint seed) {
  ivec2 cell=ivec2(floor(p))+ivec2(int(seed & 65535u),int(seed >> 16u));
  vec2 f=fract(p), s=f*f*(3.0-2.0*f), d=6.0*f*(1.0-f);
  float a=hashByte(cellHash(cell),0u), b=hashByte(cellHash(cell+ivec2(1,0)),0u);
  float c=hashByte(cellHash(cell+ivec2(0,1)),0u), e=hashByte(cellHash(cell+ivec2(1,1)),0u);
  return vec3(mix(mix(a,b,s.x),mix(c,e,s.x),s.y),mix(b-a,e-c,s.y)*d.x,mix(c-a,e-b,s.x)*d.y);
}
// x: leaf height, y: soft hollow, zw: the surface normal's horizontal components.
vec4 crownClumps(vec2 local, uint seed) {
  vec3 a=crownNoiseGradient(local*${f(CLUMPS.coarse)},seed);
  vec2 rotated=vec2(0.8*local.x-0.6*local.y,0.6*local.x+0.8*local.y);
  vec3 b=crownNoiseGradient(rotated*${f(CLUMPS.fine)}+vec2(17.0,-9.0),seed);
  float height=a.x*0.65+b.x*0.35;
  vec2 slope=a.yz*${f(CLUMPS.coarse)}*0.65+vec2(0.8*b.y+0.6*b.z,-0.6*b.y+0.8*b.z)*${f(CLUMPS.fine)}*0.35;
  return vec4(height,1.0-smoothstep(0.2,0.65,height),-slope*${f(CLUMPS.relief)});
}
float crownShade(vec2 local, vec4 clumps) {
  vec3 dome=normalize(vec3(local*${f(CROWN_LIGHT.tilt)},sqrt(max(${f(CROWN_LIGHT.minZ)},1.0-dot(local,local)))));
  vec3 clump=normalize(vec3(clumps.zw,1.0));
  float light=${f(CROWN_LIGHT.base)}+(u_crownNight ? ${f(CROWN_LIGHT.nightFlat)} : 1.0)*
    (${f(CROWN_LIGHT.domeGain)}*dot(dome,u_crownSun)+${f(CROWN_LIGHT.clumpGain)}*dot(clump,u_crownSun))+(clumps.x-0.5)*0.7;
  float ao=(1.0-${f(CROWN_LIGHT.creaseAO)}*clumps.y)*(1.0-${f(CROWN_LIGHT.rimAO)}*smoothstep(0.75,1.0,length(local)));
  return clamp(light*ao,${f(CROWN_LIGHT.min)},${f(CROWN_LIGHT.max)});
}
float crownTexture(vec2 local, uint seed) {
  ivec2 leaf=ivec2(floor(local*29.0))+ivec2(int(seed & 65535u),int(seed >> 16u));
  return (hashByte(cellHash(leaf),8u)-0.5)*0.28;
}
int crownLevel(float light, float crevice, float radius) {
  light -= 0.06*crevice+0.08*smoothstep(0.8,1.15,radius);
  int level=0;
  ${CROWN_RAMP.map((t) => `if(light>=${f(t)}) level++;`).join('\n  ')}
  return level;
}
vec3 crownTint(uint seed) {
  const vec3 tints[3]=vec3[3](${CROWN_TINTS.map((t) => `vec3(${t.map(f).join(',')})`).join(',')});
  return tints[cellHash(ivec2(int(seed),9))%3u];
}
`;

/** The shadow ray only needs the crown dome, not the leaf-clump lighting functions. */
export const foliageShadowGlsl = /* glsl */ `
float foliageShadowHeight(float h, vec2 local) {
  return h*(0.55+0.45*sqrt(max(0.0,1.0-dot(local,local))));
}
`;
