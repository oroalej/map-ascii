import type { Readback } from '../readback';
import type { EmojiCue } from './emoji';
import { CueController, type CueInView } from './cue';
import type { CueReadback } from './cue-readback';
export type EmojiInView = CueInView<EmojiCue>;
export const EMOJI_SPREAD_PX = 80;
export class EmojiController extends CueController<EmojiCue> {
  constructor(
    readback: Pick<Readback, 'size' | 'request'>,
    attachment: number,
    emit: (cues: EmojiInView[]) => void,
    clock = () => performance.now(),
    arbiter?: CueReadback,
    speechPoints?: () => readonly (readonly [number, number])[],
  ) {
    super(
      readback,
      attachment,
      emit,
      {
        kind: 'emoji',
        displayed: [4, 2],
        spread: EMOJI_SPREAD_PX,
        pick: (a) => (!a.speech && !a.aboard && !a.prop && !a.parked ? a.emoji : undefined),
        key: (c) => `${c.id}/${c.mood}`,
        group: (c) => c.pair,
        member: (a) => (a.kind === 'person' ? 0 : undefined),
        requiresSpeakers: (a) => a.kind === 'person',
      },
      clock,
      arbiter,
      speechPoints,
    );
  }
}
