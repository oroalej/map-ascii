// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { attachInput } from './input';

it('distinguishes new mouse hover and leave from a press clearing hover, retaining taps', () => {
  const canvas = document.createElement('canvas');
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  canvas.releasePointerCapture = vi.fn();
  const intents = {
    pan: vi.fn(),
    zoom: vi.fn(),
    hover: vi.fn(),
    tap: vi.fn(),
    pointerActivity: vi.fn(),
  };
  const detach = attachInput(canvas, intents);
  const send = (type: string, pointerType = 'mouse') => {
    const event = new Event(type);
    Object.assign(event, { pointerId: 1, pointerType, button: 0, clientX: 5, clientY: 6 });
    canvas.dispatchEvent(event);
  };
  send('pointermove');
  expect(intents.pointerActivity).toHaveBeenLastCalledWith(false);
  send('pointerdown');
  expect(intents.hover).toHaveBeenLastCalledWith(null);
  expect(intents.pointerActivity).toHaveBeenCalledTimes(1);
  send('pointerup');
  expect(intents.tap).toHaveBeenCalledWith([5, 6], 'mouse');
  send('pointerleave');
  expect(intents.pointerActivity).toHaveBeenLastCalledWith(true);
  send('pointermove', 'touch');
  expect(intents.pointerActivity).toHaveBeenCalledTimes(2);
  detach();
});
