import { priorityDiagnostics } from './testing/priority-diagnostics';

priorityDiagnostics({
  name: 'crossroads',
  entries: [10, 12, 4],
  perArm: [
    [2, 3, 2, 3],
    [3, 3, 3, 3],
    [2, 0, 2, 0],
  ],
  bounds: { maxWaited: 53.14, peakStall: 50.4, stallsOver30: 2, twoCarFreezes: 1 },
});
