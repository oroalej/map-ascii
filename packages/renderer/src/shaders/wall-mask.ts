import { Dir } from '../glyphs/select';

/** Shared GLSL twin of glyphs/select.ts wallMask; o[4] is the center, not an edge. */
export const wallJoinGlsl = /* glsl */ `
int joinMask(bool o[9]) {
  bool edge = false;
  for (int i=0; i<9; i++) if (i != 4) edge = edge || o[i];
  if (!edge) return -1;
  return (!o[1] && (o[3] || o[0] || o[5] || o[2]) ? ${Dir.N} : 0)
    | (!o[5] && (o[1] || o[2] || o[7] || o[8]) ? ${Dir.E} : 0)
    | (!o[7] && (o[3] || o[6] || o[5] || o[8]) ? ${Dir.S} : 0)
    | (!o[3] && (o[1] || o[0] || o[7] || o[6]) ? ${Dir.W} : 0);
}
`;
