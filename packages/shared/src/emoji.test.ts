import { expect, it } from 'vitest';
import { EMOJI_MOODS, EMOJI_SUBJECTS, emojiGlyph } from './emoji';

it('resolves every mood to an allowed single-code-point system emoji', () => {
  const allowed = new Set(
    '😤 😠 😑 😊 😎 😋 😄 😌 😓 ☔ 😪 💤 😅 👋 👍 ☕ 🥵 💨 🙏 📚 🏀 📸 🌾 🎁 ❤️ 🎄 ⭐ 🎉 🥳 🎶 🍻 🍺 🎈 🍖 🎆 😨 😣 💢 💕 💦 ❗ 😾 😺 🙀 💩 👀 📢 🦟 🎤 🤧 💅 🙄 🤤 🤑 😭 😵 🤔 🤪 😢 😇 🤫 🥱 🕯️ 🥺'.split(
      ' ',
    ),
  );
  for (const subject of EMOJI_SUBJECTS)
    for (const mood of EMOJI_MOODS) {
      const glyph = emojiGlyph(subject, mood);
      expect(allowed.has(glyph)).toBe(true);
      const points = [...glyph];
      expect(points.length === 1 || (points.length === 2 && points[1] === '\uFE0F')).toBe(true);
    }
  expect(emojiGlyph('driver', 'rained')).toBe('😣');
  expect(emojiGlyph('cat', 'scared')).toBe('🙀');
  expect(emojiGlyph('dog', 'scared')).toBe('❗');
  expect(EMOJI_MOODS.filter((mood) => mood === 'crying')).toHaveLength(1);
  expect(new Set(EMOJI_MOODS).size).toBe(EMOJI_MOODS.length);
  expect(EMOJI_MOODS).toHaveLength(57);
  expect(emojiGlyph('person', 'candle')).toBe('🕯️');
  expect(emojiGlyph('person', 'melting')).toBe('😵');
  expect(emojiGlyph('person', 'moved')).toBe('😢');
});
