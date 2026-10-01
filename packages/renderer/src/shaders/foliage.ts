/** Crown-local lighting shared by select and glyph programs. CPU twins: glyphs/select.ts. */
import { CLUMPS, CROWN_BANKS, CROWN_LIGHT, CROWN_RAMP, CROWN_TINTS } from '../glyphs/select';
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
/** Full-resolution composition only needs tint and an inexpensive isolated-tip fallback. */
export const foliageColorGlsl = /* glsl */ `
uniform vec3 u_crownSun;
uniform bool u_crownNight;
vec3 crownTint(uint seed) {
  const vec3 tints[3]=vec3[3](${CROWN_TINTS.map((t) => `vec3(${t.map(f).join(',')})`).join(',')});
  return tints[cellHash(ivec2(int(seed),9))%3u];
}
float crownEdgeLight(vec2 local) {
  vec3 dome=normalize(vec3(local*${f(CROWN_LIGHT.tilt)},sqrt(max(${f(CROWN_LIGHT.minZ)},1.0-dot(local,local)))));
  return ${f(CROWN_LIGHT.base + CROWN_LIGHT.domeGain)}+
    (u_crownNight ? ${f(CROWN_LIGHT.nightFlat)} : 1.0)*${f(CROWN_LIGHT.domeGain)}*dot(dome,u_crownSun);
}
`;

export const foliageGlsl = /* glsl */ `
${foliageColorGlsl}
float hashByte(uint h, uint shift) { return float((h >> shift) & 255u) / 255.0; }

// Height and analytic derivatives of a seeded leaf cluster field.
vec3 crownNoiseGradient(vec2 p, uint seed) {
  ivec2 cell=ivec2(floor(p))+ivec2(int(seed & 65535u),int(seed >> 16u));
  vec2 f=fract(p), s=f*f*(3.0-2.0*f), d=6.0*f*(1.0-f);
  float a=hashByte(cellHash(cell),0u), b=hashByte(cellHash(cell+ivec2(1,0)),0u);
  float c=hashByte(cellHash(cell+ivec2(0,1)),0u), e=hashByte(cellHash(cell+ivec2(1,1)),0u);
  return vec3(mix(mix(a,b,s.x),mix(c,e,s.x),s.y),mix(b-a,e-c,s.y)*d.x,mix(c-a,e-b,s.x)*d.y);
}
// Each raised branch bank has a rounded top and a steep, smooth shoulder over lower leaves.
// surface: highest/second-highest elevation and the winning surface's analytic gradient.
void crownBank(vec2 p, vec3 edge, uint seed, int index, vec4 bank, inout vec4 surface) {
  uint h=cellHash(ivec2(int(seed),index+71));
  if(index<7 && ((h>>24u)&7u)==0u) return;
  vec2 d=p-bank.xy-(vec2(hashByte(h,0u),hashByte(h,8u))*2.0-1.0)*${f(CLUMPS.jitter)};
  float width=${f(CLUMPS.radius)}+hashByte(h,16u)*${f(CLUMPS.radiusSpread)};
  float depth=width*(0.45+hashByte(h,24u)*0.8);
  vec2 q=vec2(dot(d,bank.zw)/width,dot(d,vec2(-bank.w,bank.z))/depth);
  float radius2=dot(q,q), shape=1.0-(edge.x-0.5)*${f(CLUMPS.edgeWarp)};
  float v=1.0-radius2*shape;
  if(v<=0.0) return;
  float tier=${f(CLUMPS.tier)}+hashByte(h,24u)*${f(CLUMPS.tierSpread)}+(index>=7 ? ${f(CLUMPS.innerLift)} : 0.0);
  float height=tier*smoothstep(0.0,${f(CLUMPS.shoulder)},v)+${f(CLUMPS.cap)}*v;
  if(height>surface.x) {
    surface.y=surface.x;
    surface.x=height;
    float t=min(1.0,v/${f(CLUMPS.shoulder)});
    float slope=${f(CLUMPS.cap)}+tier*6.0*t*(1.0-t)/${f(CLUMPS.shoulder)};
    surface.zw=slope*(-2.0*shape*vec2(q.x*bank.z/width-q.y*bank.w/depth,q.x*bank.w/width+q.y*bank.z/depth)
      +radius2*edge.yz*${f(CLUMPS.edgeScale)}*${f(CLUMPS.edgeWarp)});
  } else surface.y=max(surface.y,height);
}
// x: leaf height, y: shaded join, zw: the surface normal's horizontal components.
vec4 crownClumps(vec2 local, uint seed) {
  uint h=cellHash(ivec2(int(seed),37));
  vec2 rotation=normalize(vec2(hashByte(h,0u),hashByte(h,8u))*2.0-1.0);
  vec2 p=vec2(dot(local,rotation),dot(local,vec2(-rotation.y,rotation.x)));
  vec3 ground=crownNoiseGradient(p*${f(CLUMPS.coarse)},seed);
  vec3 edge=crownNoiseGradient(p*${f(CLUMPS.edgeScale)}+vec2(17.0,-9.0),seed);
  float base=0.3+ground.x*0.16;
  vec4 surface=vec4(base,base,ground.yz*${f(CLUMPS.coarse)}*0.16);
  ${CROWN_BANKS.map((bank, i) => `crownBank(p,edge,seed,${i},vec4(${bank.map(f).join(',')}),surface);`).join('\n  ')}
  vec2 slope=vec2(rotation.x*surface.z-rotation.y*surface.w,rotation.y*surface.z+rotation.x*surface.w);
  return vec4(surface.x,1.0-smoothstep(0.015,${f(CLUMPS.crease)},surface.x-surface.y),-slope*${f(CLUMPS.relief)});
}
float crownShade(vec2 local, vec4 clumps) {
  vec3 dome=normalize(vec3(local*${f(CROWN_LIGHT.tilt)},sqrt(max(${f(CROWN_LIGHT.minZ)},1.0-dot(local,local)))));
  vec3 clump=normalize(vec3(clumps.zw,1.0));
  float light=${f(CROWN_LIGHT.base)}+(u_crownNight ? ${f(CROWN_LIGHT.nightFlat)} : 1.0)*
    (${f(CROWN_LIGHT.domeGain)}*dot(dome,u_crownSun)+${f(CROWN_LIGHT.clumpGain)}*dot(clump,u_crownSun))+(clumps.x-0.5)*${f(CROWN_LIGHT.heightGain)};
  float ao=(1.0-${f(CROWN_LIGHT.creaseAO)}*clumps.y)*(1.0-${f(CROWN_LIGHT.rimAO)}*smoothstep(0.75,1.0,length(local)));
  return clamp(light*ao,${f(CROWN_LIGHT.min)},${f(CROWN_LIGHT.max)});
}
float crownTexture(vec2 local, uint seed) {
  ivec2 leaf=ivec2(floor(local*29.0))+ivec2(int(seed & 65535u),int(seed >> 16u));
  return (hashByte(cellHash(leaf),8u)-0.5)*${f(CLUMPS.grain)};
}
int crownLevel(float light, float crevice, float radius) {
  light -= 0.06*crevice+0.08*smoothstep(0.8,1.15,radius);
  int level=0;
  ${CROWN_RAMP.map((t) => `if(light>=${f(t)}) level++;`).join('\n  ')}
  return level;
}
`;

/** The shadow ray only needs the crown dome, not the leaf-clump lighting functions. */
export const foliageShadowGlsl = /* glsl */ `
float foliageShadowHeight(float h, vec2 local) {
  return h*(0.55+0.45*sqrt(max(0.0,1.0-dot(local,local))));
}
`;
