/** Crown-local lighting shared by select and glyph programs. CPU twins: glyphs/select.ts. */
import { CLUMPS, CROWN_LIGHT, CROWN_RAMP, CROWN_TINTS } from '../glyphs/select';
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
// Emit fixed centers so drivers do not need dynamic constant-array indexing.
const centers = Array.from({ length: CLUMPS.count }, (_, i) => {
  const angle = ((i - 1) * Math.PI) / 3;
  const ax = i === 0 ? 0 : Math.round(Math.cos(angle) * 2) / 2;
  const ay = i === 0 || i === 1 || i === 4 ? 0 : ((i < 4 ? 1 : -1) * Math.sqrt(3)) / 2;
  return /* glsl */ `{
    uint h=cellHash(ivec2(int(seed),${i}));
    vec2 center=${f(CLUMPS.ring)}*vec2((${f(ax)})*rotation.x-(${f(ay)})*rotation.y,(${f(ax)})*rotation.y+(${f(ay)})*rotation.x)
      +(vec2(hashByte(h,0u),hashByte(h,8u))*2.0-1.0)*${f(CLUMPS.jitter)};
    float radius=${f(CLUMPS.radius)}+(hashByte(h,16u)*2.0-1.0)*${f(CLUMPS.radiusJitter)};
    vec2 d=(local-center)/radius;
    float dd=dot(d,d);
    if(dd<f1) { f2=f1; f1=dd; best=d; } else if(dd<f2) f2=dd;
  }`;
}).join('\n  ');
export const foliageGlsl = /* glsl */ `
uniform vec3 u_crownSun;
uniform bool u_crownNight;
float hashByte(uint h, uint shift) { return float((h >> shift) & 255u) / 255.0; }

// x: dome top, y: crease, zw: offset from the nearest clump in its own radius.
vec4 crownClumps(vec2 local, uint seed) {
  uint rh = cellHash(ivec2(int(seed),37));
  vec2 rotation = vec2(hashByte(rh,0u),hashByte(rh,8u))*2.0-1.0;
  rotation /= max(length(rotation),0.00001);
  float f1=1e9, f2=1e9;
  vec2 best=vec2(0);
  ${centers}
  return vec4(sqrt(max(0.0,1.0-f1)),1.0-smoothstep(0.0,${f(CLUMPS.crease)},sqrt(f2)-sqrt(f1)),best);
}
float crownShade(vec2 local, vec4 clumps) {
  vec3 dome=normalize(vec3(local*${f(CROWN_LIGHT.tilt)},sqrt(max(${f(CROWN_LIGHT.minZ)},1.0-dot(local,local)))));
  vec3 clump=normalize(vec3(clumps.zw,max(${f(CROWN_LIGHT.minZ)},clumps.x)));
  float light=${f(CROWN_LIGHT.base)}+(u_crownNight ? ${f(CROWN_LIGHT.nightFlat)} : 1.0)*
    (${f(CROWN_LIGHT.domeGain)}*dot(dome,u_crownSun)+${f(CROWN_LIGHT.clumpGain)}*dot(clump,u_crownSun));
  float ao=(1.0-${f(CROWN_LIGHT.creaseAO)}*clumps.y)*(1.0-${f(CROWN_LIGHT.rimAO)}*smoothstep(0.75,1.0,length(local)));
  return clamp(light*ao,${f(CROWN_LIGHT.min)},${f(CROWN_LIGHT.max)});
}
int crownLevel(float light, float crevice, float radius) {
  int level=0;
  ${CROWN_RAMP.map((t) => `if(light>=${f(t)}) level++;`).join('\n  ')}
  if(crevice>0.6) level=min(level,1);
  if(radius>0.75) level=min(level,2);
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
