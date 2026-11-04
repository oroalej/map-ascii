/**
 * Small programs for optional passes (the morph, the bloom). They link in the background and are
 * never waited on: a pass whose program isn't ready skips the frame, and one that fails to link
 * stays off rather than breaking the map.
 */
import type * as twgl from 'twgl.js';
import { prepareProgram, type GL, type PendingProgram } from './gpu';

export type OptionalLink = { pending: PendingProgram; info?: twgl.ProgramInfo; failed?: boolean };
export type OptionalLinks = Map<string, OptionalLink>;

/** The program, once it has linked; the first ask submits it. */
export function optionalProgram(
  gl: GL,
  programs: { optional?: OptionalLinks },
  name: string,
  vertex: string,
  fragment: string,
): twgl.ProgramInfo | undefined {
  const links = programs.optional;
  if (!links) return undefined;
  let link = links.get(name);
  if (!link) {
    try {
      link = { pending: prepareProgram(gl, vertex, fragment) };
    } catch {
      return undefined;
    }
    links.set(name, link);
  }
  if (link.info || link.failed) return link.info;
  if (!link.pending.ready()) return undefined;
  try {
    link.info = link.pending.finish();
  } catch {
    link.failed = true;
  }
  return link.info;
}

export function deleteOptionalPrograms(gl: GL, links: OptionalLinks | undefined): void {
  for (const link of links?.values() ?? []) {
    if (link.info) {
      if (!gl.isContextLost()) gl.deleteProgram(link.info.program);
    } else link.pending.cancel();
  }
  links?.clear();
}
