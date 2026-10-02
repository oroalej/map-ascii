/** Crown-local lighting shared by select and glyph programs. CPU twins: glyphs/select.ts. */
import {
  CLUMPS,
  CROWN_BANK_COUNT,
  CROWN_DENSITY_STEPS,
  CROWN_LIGHT,
  CROWN_PIGMENT,
  CROWN_RAMP,
  CROWN_TINTS,
} from '../glyphs/select';
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
/** Full-resolution composition only needs tint and an inexpensive isolated-tip fallback. */
export const foliageColorGlsl = /* glsl */ `
uniform vec3 u_crownSun;
uniform bool u_crownNight;
vec3 crownTint(uint seed) {
  const vec3 tints[3]=vec3[3](${CROWN_TINTS.map((t) => `vec3(${t.map(f).join(',')})`).join(',')});
  return tints[cellHash(ivec2(int(seed),9))%3u];
}
float crownPigment(float light, int windLevel) {
  return ${f(CROWN_PIGMENT.base)}+${f(CROWN_PIGMENT.gain)}*clamp(light,${f(CROWN_LIGHT.min)},${f(CROWN_LIGHT.max)})
    +${f(CROWN_PIGMENT.wind)}*float(clamp(windLevel,0,3));
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
void crownBank(vec2 p, vec3 edge, uint seed, int index, int outer, int inner, inout vec4 surface) {
  if(index>=outer+inner) return;
  uint h=cellHash(ivec2(int(seed),index+71));
  bool isInner=index>=outer;
  float angle=isInner ? hashByte(h,0u)*6.28318530718
    : (float(index)+0.5+(hashByte(h,0u)*2.0-1.0)*${f(CLUMPS.jitter)})*6.28318530718/float(outer);
  float reach=isInner ? 0.12+hashByte(h,8u)*0.18 : 0.45+hashByte(h,8u)*0.28;
  uint axis=cellHash(ivec2(int(seed),index+137));
  vec2 direction=normalize(vec2(hashByte(axis,0u),hashByte(axis,8u))*2.0-1.0);
  vec2 d=p-vec2(cos(angle),sin(angle))*reach;
  float width=(${f(CLUMPS.radius)}+hashByte(h,16u)*${f(CLUMPS.radiusSpread)})*(1.15-0.03*float(outer));
  float depth=width*(0.65+hashByte(h,24u)*0.6);
  vec2 q=vec2(dot(d,direction)/width,dot(d,vec2(-direction.y,direction.x))/depth);
  float radius2=dot(q,q), shape=1.0-(edge.x-0.5)*${f(CLUMPS.edgeWarp)};
  float v=1.0-radius2*shape;
  if(v<=0.0) return;
  float tier=isInner ? ${f(CLUMPS.innerTier + CLUMPS.innerLift)}+hashByte(h,24u)*${f(CLUMPS.innerTierSpread)}
    : ${f(CLUMPS.tier)}+hashByte(h,24u)*${f(CLUMPS.tierSpread)};
  float height=tier*smoothstep(0.0,${f(CLUMPS.shoulder)},v)+${f(CLUMPS.cap)}*v;
  if(height>surface.x) {
    surface.y=surface.x;
    surface.x=height;
    float t=min(1.0,v/${f(CLUMPS.shoulder)});
    float slope=${f(CLUMPS.cap)}+tier*6.0*t*(1.0-t)/${f(CLUMPS.shoulder)};
    surface.zw=slope*(-2.0*shape*vec2(q.x*direction.x/width-q.y*direction.y/depth,q.x*direction.y/width+q.y*direction.x/depth)
      +radius2*edge.yz*${f(CLUMPS.edgeScale)}*${f(CLUMPS.edgeWarp)});
  } else surface.y=max(surface.y,height);
}
// x: leaf height, y: shaded join, zw: the surface normal's horizontal components.
vec4 crownClumps(vec2 local, uint seed) {
  uint h=cellHash(ivec2(int(seed),37));
  int outer=4+int((h>>16u)&3u), inner=1+int((h>>20u)&1u);
  vec2 rotation=normalize(vec2(hashByte(h,0u),hashByte(h,8u))*2.0-1.0);
  vec2 p=vec2(dot(local,rotation),dot(local,vec2(-rotation.y,rotation.x)));
  vec3 ground=crownNoiseGradient(p*${f(CLUMPS.coarse)},seed);
  vec3 edge=crownNoiseGradient(p*${f(CLUMPS.edgeScale)}+vec2(17.0,-9.0),seed);
  float base=0.3+ground.x*0.16;
  vec4 surface=vec4(base,base,ground.yz*${f(CLUMPS.coarse)}*0.16);
  ${Array.from({ length: CROWN_BANK_COUNT }, (_, i) => `crownBank(p,edge,seed,${i},outer,inner,surface);`).join('\n  ')}
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
  int density=int(floor(light*${f(CROWN_DENSITY_STEPS)}+0.5))-
    int(floor((0.06*crevice+0.08*smoothstep(0.8,1.15,radius))*${f(CROWN_DENSITY_STEPS)}+0.5));
  int level=0;
  ${CROWN_RAMP.map((t) => `if(density>=${Math.round(t * CROWN_DENSITY_STEPS)}) level++;`).join('\n  ')}
  return level;
}
`;

/** The shadow ray only needs the crown dome, not the leaf-clump lighting functions. */
export const foliageShadowGlsl = /* glsl */ `
float foliageShadowHeight(float h, vec2 local) {
  return h*(0.55+0.45*sqrt(max(0.0,1.0-dot(local,local))));
}
`;
