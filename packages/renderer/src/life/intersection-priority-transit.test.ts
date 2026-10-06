import { priorityDiagnostics } from './testing/priority-diagnostics';

priorityDiagnostics({
  name: 'transit',
  transit: true,
  entries: [8, 10, 7],
  perArm: [
    [2, 2, 2, 2],
    [2, 3, 2, 3],
    [1, 2, 2, 2],
  ],
  bounds: { maxWaited: 57.67, peakStall: 47.5, stallsOver30: 5, twoCarFreezes: 1 },
});
