import { expect, it } from 'vitest';
import { EMOJI_MOODS, EMOJI_SUBJECTS, emojiGlyph } from './emoji';

it('resolves every mood to an allowed single-code-point system emoji', () => {
  const allowed = new Set(
    '😤 😠 😑 😊 😎 😋 😄 😌 😓 ☔ 😪 💤 😅 👋 👍 ☕ 🥵 💨 🙏 📚 🏀 📸 🌾 🎁 ❤️ 🎄 ⭐ 🎉 🥳 🎶 🍻 🍺 🎈 🍖 🎆 😨 😣 💢 💕 💦 ❗ 😾 😺 🙀'.split(
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
});
