import { z } from 'zod';
import { LanguageCode, localizedText, Source } from './schemas';

export const DialogueKind = z.enum(['greet', 'talk', 'ball', 'look']);
export const GreetingPeriod = z.enum(['morning', 'afternoon', 'evening']);
const language = z.object({ code: LanguageCode, label: z.string().min(1).max(32) }).strict();

/** Curated simulated speech. Missing catalogs are supported; incomplete translations are not. */
export function dialogueCatalog(languages?: readonly string[]) {
  return z
    .object({
      native: language,
      translations: z.array(language).max(6),
      exchanges: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-z0-9-]+$/),
              kind: DialogueKind,
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
        .max(100),
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
        if (
          ((exchange.kind === 'greet' || exchange.kind === 'ball') && count !== 2) ||
          (exchange.kind === 'talk' && count < 2) ||
          (exchange.kind === 'look' && count !== 1)
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

/** Text-free worker configuration; language switches never reach the simulation. */
export const DialogueChoice = z.object({
  id: z.string(),
  kind: DialogueKind,
  period: GreetingPeriod.optional(),
  turns: z.number().int().min(1).max(3),
});
export type DialogueChoice = z.infer<typeof DialogueChoice>;
