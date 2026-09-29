import { describe, expect, it } from 'vitest';
import { moonAltitude, moonIllumination, moonlight } from './moon';

const NAGA = { lng: 123.19, lat: 13.62 };

describe('moonIllumination', () => {
  it('is full at a full moon and dark at a new moon', () => {
    // Full moon 2024-01-25 17:54 UTC; new moon 2024-01-11 11:57 UTC.
    expect(moonIllumination(new Date(Date.UTC(2024, 0, 25, 17, 54)))).toBeGreaterThan(0.98);
    expect(moonIllumination(new Date(Date.UTC(2024, 0, 11, 11, 57)))).toBeLessThan(0.02);
  });

  it('is about half lit at a quarter', () => {
    // First quarter 2024-01-18 03:53 UTC.
    expect(moonIllumination(new Date(Date.UTC(2024, 0, 18, 3, 53)))).toBeCloseTo(0.5, 1);
  });
});

describe('moonAltitude', () => {
  it('has a full moon high around local midnight and below the horizon around local noon', () => {
    // Full moon 2024-01-25; Naga is UTC+8, so local midnight is 16:00 UTC and noon 04:00 UTC.
    const midnight = new Date(Date.UTC(2024, 0, 25, 16));
    const noon = new Date(Date.UTC(2024, 0, 26, 4));
    expect(moonAltitude(midnight, NAGA.lng, NAGA.lat)).toBeGreaterThan(50);
    expect(moonAltitude(noon, NAGA.lng, NAGA.lat)).toBeLessThan(-30);
  });
});

describe('moonlight', () => {
  it('is bright under a high full moon and none when it is down or new', () => {
    const { lng, lat } = NAGA;
    expect(moonlight(new Date(Date.UTC(2024, 0, 25, 16)), lng, lat)).toBeGreaterThan(0.9);
    expect(moonlight(new Date(Date.UTC(2024, 0, 26, 4)), lng, lat)).toBe(0);
    expect(moonlight(new Date(Date.UTC(2024, 0, 11, 4)), lng, lat)).toBeLessThan(0.05);
  });
});
