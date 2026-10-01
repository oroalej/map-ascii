import { FOLIAGE_INK } from '../glyphs/foliage-ink';

/** The CPU twin is foliageInkSample; reject transformed coordinates before atlas access. */
export const foliageInkGlsl = /* glsl */ `
float foliageInk(ivec2 slot, ivec2 inCell, ivec2 world) {
  uint h=cellHash(world);
  vec3 random=vec3(float(h & 255u),float((h>>8u)&255u),float((h>>16u)&255u))/255.0;
  float scale=${FOLIAGE_INK.minScale}+random.x*${FOLIAGE_INK.scaleRange};
  vec2 p=(vec2(inCell)+0.5)/u_cell-0.5-(random.yz-0.5)*vec2(${FOLIAGE_INK.jitterX},${FOLIAGE_INK.jitterY});
  float turn=(float(h>>24u)/255.0*2.0-1.0)*${FOLIAGE_INK.maxSin};
  float upright=sqrt(1.0-turn*turn);
  vec2 sampleAt=(vec2(p.x*upright+p.y*turn,
    -p.x*turn+p.y*upright)/scale+0.5)*u_cell;
  if(any(lessThan(sampleAt,vec2(0.0))) || any(greaterThanEqual(sampleAt,u_cell))) return 0.0;
  return texelFetch(u_atlas,slot+ivec2(floor(sampleAt)),0).r;
}
`;
