import type { Dish, RuntimeCityLife, RuntimeDialogueCatalog } from '@atlas/shared';
import { gunzipSync, strFromU8 } from 'fflate';

/** Validated pack data transported inline, with the same values consumed by the renderer/HUD. */
export type InlineRuntime = {
  dishes?: readonly Dish[] | undefined;
  cityLife?: RuntimeCityLife | undefined;
  dialogue?: RuntimeDialogueCatalog | undefined;
};

/** Decode synchronously before rendering consumers; no network or delayed initialization. */
export function decodeInlineRuntime(gzipBase64: string): InlineRuntime {
  const bytes = Uint8Array.from(atob(gzipBase64), (char) => char.charCodeAt(0));
  return JSON.parse(strFromU8(gunzipSync(bytes))) as InlineRuntime;
}
