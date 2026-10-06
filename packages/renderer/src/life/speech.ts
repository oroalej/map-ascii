import type { Readback } from '../readback';
import type { SpeechCue } from './moments';
import { CueController, type CueFrame, type CueInView } from './cue';
import type { CueReadback } from './cue-readback';
export type SpeechInView = CueInView<SpeechCue>;
export type SpeechFrame = CueFrame;
/** Compatibility wrapper: standalone scheduling and public speech keys are unchanged. */
export class SpeechController extends CueController<SpeechCue> {
  constructor(
    readback: Pick<Readback, 'size' | 'request'>,
    attachment: number,
    emit: (cues: SpeechInView[]) => void,
    clock = () => performance.now(),
    arbiter?: CueReadback,
  ) {
    super(
      readback,
      attachment,
      emit,
      {
        kind: 'speech',
        displayed: [3, 2],
        pick: (a) => (a.kind === 'person' && !a.prop && !a.aboard ? a.speech : undefined),
        key: (c) => `${c.id}/${c.exchangeId}/${c.line}/${c.member ?? 0}`,
        member: (_a, c) => c.member ?? 0,
        requiresSpeakers: (a, c) => !!a.vehicle || c.member !== undefined,
      },
      clock,
      arbiter,
    );
  }
}
