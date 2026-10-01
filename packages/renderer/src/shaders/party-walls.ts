import { ROOF_BUILDING_CLASSES } from '@atlas/shared';
import { classId, Flags } from '../classes';

/** CPU twin: glyphs/party-walls.ts. The 5x5 cache is only populated at compatible contacts. */
export const partyWallsGlsl = /* glsl */ `
bool roofBuilding(int cls) { return ${ROOF_BUILDING_CLASSES.map((c) => `cls == ${classId(c)}`).join(' || ')}; }
uint partyIds[25];
bool partyMembers[25];
bool partyThrough[25];
int partyIndex(ivec2 p) { return (p.y + 2) * 5 + p.x + 2; }
bool partyMember(ivec2 p) { return partyMembers[partyIndex(p)]; }
bool partyOutside(ivec2 p) { return !partyMember(p) && !partyThrough[partyIndex(p)]; }
bool partyShared(ivec2 p, ivec2 d) {
  return partyMember(p) && partyMember(p+d) && partyIds[partyIndex(p)] != partyIds[partyIndex(p+d)];
}
int partyExternal(ivec2 p) {
  bool o[9]; bool edge = false;
  for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
    bool outside = partyOutside(p+ivec2(x,y));
    o[(y+1)*3+x+1] = outside;
    if (x != 0 || y != 0) edge = edge || outside;
  }
  if (!edge) return -1;
  return (!o[1] && (o[3] || o[0] || o[5] || o[2]) ? 1 : 0)
    | (!o[5] && (o[1] || o[2] || o[7] || o[8]) ? 2 : 0)
    | (!o[7] && (o[3] || o[6] || o[5] || o[8]) ? 4 : 0)
    | (!o[3] && (o[1] || o[0] || o[7] || o[6]) ? 8 : 0);
}
bool partyActive(ivec2 p) {
  return partyMember(p) && (partyExternal(p) >= 0 || partyShared(p,ivec2(1,0)) || partyShared(p,ivec2(0,1)));
}
bool partyProposes(ivec2 p, ivec2 d, int bit) {
  if ((max(0,partyExternal(p)) & bit) != 0) return true;
  ivec2 q=p+d;
  if (d.y != 0 && partyShared(p,ivec2(1,0)))
    return partyShared(q,ivec2(1,0)) || (d.y<0 && partyShared(q,ivec2(0,1))) || partyOutside(q+ivec2(1,0));
  if (d.x != 0 && partyShared(p,ivec2(0,1)))
    return partyShared(q,ivec2(0,1)) || (d.x<0 && partyShared(q,ivec2(1,0))) || partyOutside(q+ivec2(0,1));
  return false;
}
ivec2 partyDirection(int side) {
  return side==0 ? ivec2(0,-1) : side==1 ? ivec2(1,0) : side==2 ? ivec2(0,1) : ivec2(-1,0);
}
// -2 means legacy outline, -1 means interior; otherwise N/E/S/W join bits.
int partyWallMask(ivec2 p) {
  int cls=groundClassAt(p);
  if (!roofBuilding(cls)) return -2;
  vec4 attr=groundAttrAt(p);
  int style=wallRowFor(u_kind[cls],attr);
  if (attr.r<=0.0 || style<0) return -2;
  uint id=unpackId(groundIdAt(p));
  bool contact=false;
  for (int side=0;side<4;side++) {
    ivec2 q=p+partyDirection(side);
    int c=groundClassAt(q); vec4 a=groundAttrAt(q);
    if (roofBuilding(c) && a.r==attr.r && wallRowFor(u_kind[c],a)==style && unpackId(groundIdAt(q))!=id) contact=true;
  }
  if (!contact) return -2;
  for (int y=-2;y<=2;y++) for (int x=-2;x<=2;x++) {
    ivec2 q=p+ivec2(x,y); int i=partyIndex(ivec2(x,y));
    int c=groundClassAt(q); vec4 a=groundAttrAt(q);
    partyIds[i]=unpackId(groundIdAt(q));
    partyMembers[i]=roofBuilding(c) && a.r==attr.r && wallRowFor(u_kind[c],a)==style;
    partyThrough[i]=maskBit(u_seeThrough,c)==1;
  }
  if (!partyActive(ivec2(0))) return -1;
  int mask=0;
  for (int side=0;side<4;side++) {
    ivec2 d=partyDirection(side); int bit=1<<side, reverse=1<<((side+2)%4);
    if (partyActive(d) && (partyProposes(ivec2(0),d,bit) || partyProposes(d,-d,reverse))) mask |= bit;
  }
  return mask;
}
bool partySeam(ivec2 p, int cls, vec4 attr) {
  if (!roofBuilding(cls) || attr.r<=0.0 || wallRowFor(u_kind[cls],attr)>=0) return false;
  uint id=unpackId(groundIdAt(p));
  for (int side=0;side<2;side++) {
    ivec2 q=p+(side==0 ? ivec2(1,0) : ivec2(0,1));
    int c=groundClassAt(q); vec4 a=groundAttrAt(q);
    if (roofBuilding(c) && a.r==attr.r && wallRowFor(u_kind[c],a)<0
      && (int(a.g*255.0+0.5) & ${Flags.landmark}) == (int(attr.g*255.0+0.5) & ${Flags.landmark})
      && unpackId(groundIdAt(q))!=id) return true;
  }
  return false;
}
`;
