import { z } from 'zod';
import { dialogueDelivery, SCENE_PROFILES } from './dialogue-options';
import { LanguageCode, localizedText, Source } from './schemas';

export const DialogueKind = z.enum(['greet', 'talk', 'ball', 'look']);
export const DialogueDelivery = z.enum(['exchange', 'utterance']);
export type DialogueDelivery = z.infer<typeof DialogueDelivery>;
export const DialogueProfile = z.enum([
  'greeting',
  'reunion',
  'farewell',
  'directions',
  'courtesy',
  'weather',
  'food',
  'school',
  'daily-plans',
  'vendor-order',
  'vendor-thanks',
  'transit',
  'companion',
  'play',
  'place-reaction',
]);
export type DialogueProfile = z.infer<typeof DialogueProfile>;
export const DialogueAnchor = z.enum(['monument', 'fountain', 'plaza', 'stall', 'stop', 'seat']);
export type DialogueAnchor = z.infer<typeof DialogueAnchor>;
export const DialogueConditions = z
  .object({
    anchor: DialogueAnchor.optional(),
    weather: z
      .enum([
        'daylight',
        'calm',
        'breeze',
        'gust',
        'rain',
        'heavy-rain',
        'easing',
        'evening-calm',
        'heat',
        'clearing',
      ])
      .optional(),
    audience: z.enum(['adults', 'adult-child']).optional(),
    event: z.enum(['arrival', 'catch', 'pass']).optional(),
  })
  .strict();
export type DialogueConditions = z.infer<typeof DialogueConditions>;
const metadata = {
  /** Speaking turns are independent of how many people participate physically. */
  delivery: DialogueDelivery.optional(),
  profile: DialogueProfile.optional(),
  conditions: DialogueConditions.optional(),
  /** Ordered participant slots: caller/customer is 0; respondent/vendor is 1. */
  speakers: z.array(z.number().int().min(0).max(2)).min(1).max(3).optional(),
};
export const GreetingPeriod = z.enum(['morning', 'afternoon', 'evening']);
export const GreetingPeriods = z
  .object({
    morningStart: z.number().int().min(0).max(1439),
    afternoonStart: z.number().int().min(0).max(1439),
    eveningStart: z.number().int().min(0).max(1439),
  })
  .strict()
  .refine((p) => p.morningStart < p.afternoonStart && p.afternoonStart < p.eveningStart, {
    message: 'greeting period starts must be ordered',
  });
export type GreetingPeriods = z.infer<typeof GreetingPeriods>;
const language = z.object({ code: LanguageCode, label: z.string().min(1).max(32) }).strict();

/** Curated simulated speech. Missing catalogs are supported; incomplete translations are not. */
export function dialogueCatalog(languages?: readonly string[]) {
  return z
    .object({
      native: language,
      periods: GreetingPeriods.optional(),
      translations: z.array(language).max(6),
      exchanges: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-z0-9-]+$/),
              kind: DialogueKind,
              ...metadata,
              period: GreetingPeriod.optional(),
              lines: z
                .array(
                  localizedText(languages).refine(
                    (text) =>
                      Object.values(text).every(
                        (line) => line.length <= 96 && !/[\r\n]/.test(line),
                      ),
                    'speech lines must be at most 96 characters on one line',
                  ),
                )
                .min(1)
                .max(3),
              sources: z.array(Source).min(1),
            })
            .strict(),
        )
        .min(1)
        .max(120),
    })
    .strict()
    .superRefine((catalog, ctx) => {
      const codes = [catalog.native.code, ...catalog.translations.map((entry) => entry.code)];
      if (new Set(codes).size !== codes.length)
        ctx.addIssue({ code: 'custom', path: ['translations'], message: 'duplicate language' });
      for (const code of codes)
        if (languages && code !== 'en' && !languages.includes(code))
          ctx.addIssue({
            code: 'custom',
            path: ['native'],
            message: `undeclared language "${code}"`,
          });
      const ids = new Set<string>();
      catalog.exchanges.forEach((exchange, i) => {
        if (ids.has(exchange.id))
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'id'],
            message: 'duplicate exchange id',
          });
        ids.add(exchange.id);
        const count = exchange.lines.length;
        const delivery = dialogueDelivery(exchange);
        const slots =
          exchange.kind === 'look'
            ? 1
            : exchange.kind === 'talk' &&
                !(exchange.profile && SCENE_PROFILES.includes(exchange.profile))
              ? 3
              : 2;
        if (exchange.profile && (!exchange.speakers || exchange.speakers.length !== count))
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'speakers'],
            message: 'profiled exchanges require one speaker per turn',
          });
        if (
          exchange.speakers &&
          (exchange.speakers.length !== count ||
            exchange.speakers.some((speaker) => speaker >= slots) ||
            (count > 1 && new Set(exchange.speakers).size < 2))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'speakers'],
            message: 'invalid participant roles',
          });
        const profile = exchange.profile;
        if (
          profile &&
          ((profile === 'greeting' && exchange.kind !== 'greet') ||
            (profile === 'play' && exchange.kind !== 'ball') ||
            (profile === 'place-reaction' && !['look', 'talk'].includes(exchange.kind)) ||
            (!['greeting', 'play', 'place-reaction'].includes(profile) && exchange.kind !== 'talk'))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'kind'],
            message: 'profile and mechanism disagree',
          });
        if (
          (profile === 'directions' && !exchange.conditions?.anchor) ||
          (profile === 'weather' && !exchange.conditions?.weather) ||
          (exchange.conditions?.event === 'arrival' && profile !== 'transit') ||
          ((exchange.conditions?.event === 'catch' || exchange.conditions?.event === 'pass') &&
            profile !== 'play') ||
          (exchange.conditions?.audience === 'adult-child' && profile !== 'companion') ||
          (profile === 'vendor-order' && delivery !== 'exchange') ||
          (profile === 'directions' && delivery !== 'exchange') ||
          (profile?.startsWith('vendor-') && delivery === 'exchange' && count !== 2)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'conditions'],
            message: 'unsupported scene conditions',
          });
        if (
          (delivery === 'utterance' && count !== 1) ||
          (delivery === 'exchange' && count < 2) ||
          ((exchange.kind === 'greet' || exchange.kind === 'ball') &&
            delivery === 'exchange' &&
            count !== 2) ||
          (exchange.kind === 'look' && delivery !== 'utterance')
        )
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'lines'],
            message: 'invalid speaking turn count',
          });
        if ((exchange.kind === 'greet') !== (exchange.period !== undefined))
          ctx.addIssue({
            code: 'custom',
            path: ['exchanges', i, 'period'],
            message: 'only greetings require a period',
          });
        exchange.lines.forEach((line, j) => {
          for (const code of codes)
            if (!line[code])
              ctx.addIssue({
                code: 'custom',
                path: ['exchanges', i, 'lines', j, code],
                message: 'missing speech translation',
              });
        });
      });
    });
}
export const DialogueCatalog = dialogueCatalog();
export type DialogueCatalog = z.infer<typeof DialogueCatalog>;

/** Validated pack fields needed by the browser; editorial sources stay on the server. */
export const RuntimeDialogueCatalog = z
  .object({
    ...DialogueCatalog.shape,
    exchanges: z
      .array(DialogueCatalog.shape.exchanges.element.omit({ sources: true }))
      .min(1)
      .max(120),
  })
  .strict();
export type RuntimeDialogueCatalog = z.infer<typeof RuntimeDialogueCatalog>;

/** Text-free worker configuration; language switches never reach the simulation. */
export const DialogueChoice = z.object({
  id: z.string(),
  kind: DialogueKind,
  ...metadata,
  period: GreetingPeriod.optional(),
  turns: z.number().int().min(1).max(3),
});
export type DialogueChoice = z.infer<typeof DialogueChoice>;
