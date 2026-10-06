/** Simulation identities stay local; worker replies transfer only drawable fields. */
import { PROCESSION_GEOMETRY } from '@atlas/shared';
import type { VisibleAgent } from './simulate';
import { ProcessionGlyph } from './procession-glyphs';
import { VEHICLES } from './vehicles';

const identities = new WeakMap<VisibleAgent, string>();
export const eventActor = (agent: VisibleAgent | undefined) => agent && identities.get(agent);
export function identifyEventActor<T extends VisibleAgent>(agent: T, id: string): T {
  identities.set(agent, id);
  return agent;
}
/** Raw physical dimensions; permission probes add their own padding. */
export const eventBodySize = (agent: Pick<VisibleAgent, 'vehicle' | 'glyph'>) =>
  agent.vehicle
    ? VEHICLES[agent.vehicle]
    : agent.glyph === ProcessionGlyph.andas
      ? PROCESSION_GEOMETRY.andas
      : PROCESSION_GEOMETRY.person;
