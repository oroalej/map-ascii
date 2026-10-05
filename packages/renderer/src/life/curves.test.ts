import { describe, expect, it } from 'vitest';
import { curvePose, fillet, type Pose } from './curves';

const pm = 2;
const pose = (): Pose => ({ x: 0, y: 0, hx: 0, hy: 0 });

/** Headings along a curve, from its start to its end, in radians. */
function headings(c: NonNullable<ReturnType<typeof fillet>>, steps = 40) {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = curvePose(c, -c.before + ((c.before + c.after) * i) / steps, pose());
    out.push(Math.atan2(p.hy, p.hx));
  }
  return out;
}

describe('corner curves', () => {
  it('refuses a curve whose offset tangents meet beyond its ends', () => {
    // A shallow bend where the lane moves 0.7 m sideways: the offset lines cross far past the
    // curve's span, which used to loop the heading round.
    const angle = (8 * Math.PI) / 180;
    expect(
      fillet(0, 0, 1, 0, Math.cos(angle), Math.sin(angle), 3 * pm, 3 * pm, 2.5 * pm, 1.8 * pm, pm),
    ).toBeUndefined();
  });

  it('turns smoothly, never further than the corner', () => {
    const c = fillet(0, 0, 1, 0, 0, 1, 8 * pm, 8 * pm, 2 * pm, 2 * pm, pm)!;
    const h = headings(c);
    for (let i = 1; i < h.length; i++) {
      const step = h[i]! - h[i - 1]!;
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      expect(step).toBeLessThan(0.2);
    }
    expect(h[0]).toBeCloseTo(0);
    expect(h.at(-1)).toBeCloseTo(Math.PI / 2);
  });

  it('can run on past its vertex before turning, meeting both straights', () => {
    // A left turn from the left of the incoming road into the right lane of the outgoing one.
    const c = fillet(0, 0, 1, 0, 0, -1, 1 * pm, 9 * pm, -3.5 * pm, 2 * pm, pm)!;
    expect(c).toBeDefined();
    const start = curvePose(c, -c.before, pose()),
      end = curvePose(c, c.after, pose());
    expect(start.x / pm).toBeCloseTo(-1);
    expect(start.y / pm).toBeCloseTo(-3.5);
    expect(start.hx).toBeCloseTo(1);
    expect(end.y / pm).toBeCloseTo(-9);
    expect(end.hy).toBeCloseTo(-1);
  });
});
