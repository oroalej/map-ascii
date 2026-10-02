# Naga ambient dialogue

The catalog contains 100 short, fictional exchanges in 15 scene categories. All turns include Central Bikol, English and Tagalog. These are illustrative conversations, not quotations from residents or claims about actual businesses, products, fares or timetables.

New scripts are original compositions. [Jon Epstein's *Standard Bikol* (Peace Corps, 1967)](https://files.eric.ed.gov/fulltext/ED018772.pdf) supplies grammatical reference for actor/goal focus, pronouns, questions and demonstratives. [Malcolm Mintz's *Bikol Dictionary* (University of Hawaii Press, 1971)](https://manifold.uhpress.hawaii.edu/projects/bikol-dictionary) supplies lexical reference. Existing catalog entries retain their original sources. A reference supports language forms; it does not attest each authored sentence.

Structural validation checks the exact count, category allocation, translations, speaker slots and duplicate complete scripts. Editorial review checks meaning, concise wording, age suitability and context. Native-speaker review has **not** occurred; idiomatic wording remains a content follow-up. No native-language approval is implied by a source citation.

The weather-warm ID is retained from the plan but describes daylight, because the simulation has no measured temperature. School and weekend dialogue expresses fictional plans without asserting school hours or the current weekday. Common loanwords such as fountain and monumento are intentional. Direction remarks require a nearby mapped anchor and do not provide route instructions.

The 100-ID editorial inventory and per-turn review sheet are retained with the implementation handoff under `.plans/active/human-moments-100/` during implementation, then `.plans/done/human-moments-100/` at completion.

Following the project owner's feedback that "andam" was unfamiliar in their childhood usage, all six occurrences across five exchanges were replaced with context-specific wording. The companion question became "Madya na?" ("Shall we go?"); translations follow the revised meaning. Dictionary attestation alone does not establish locally familiar everyday usage.

## Conversational edit

A second editorial pass reviewed all 100 exchanges as paired speech and revised 63. The original wording often repeated a prompt without adding a useful reply, switched topics abruptly, or sounded more like a phrasebook than a brief encounter. This pass is an editorial improvement, not native-speaker certification.

The review checks each exchange for:

- A reply that answers, acknowledges or sensibly follows the first turn. Avoid adding an unanswered question to the final turn. A vendor checking a price may explicitly ask the customer to wait; the script does not invent a number to close the exchange.
- Short spoken wording and useful variation. Greeting reciprocation, quantity confirmation and a simple thank-you remain appropriate; replacing every repetition would make those less natural.
- English and Tagalog that preserve the same request, answer, tense and tone instead of mechanically copying the Bikol sentence structure.
- Fit with the actual speaker and scene. The passer offers the ball; the receiver calls for it. A nearby stall does not establish a food menu. Weather remarks use the modeled light, wind or rain rather than claiming a measured temperature or ambient silence.
- No invented local slang, prices, route details or kinship. Familiarity cannot be established by a dictionary entry alone. The owner's preference to avoid "andam" is retained.

Examples of the revised conversational intent:

| Exchange | Before | After |
| --- | --- | --- |
| Morning walk | "You're early today!" / "I'm just taking a walk." | "Out for a walk already?" / "Yes, before breakfast." |
| Practice | "Let's practice again." / "Okay, let's practice." | "Let's practice again." / "Okay, you first." |
| Waiting for someone | "I'll wait here." / "Thanks for waiting." | "I'll wait for you here." / "Okay, I'll be back." |
| Familiar place | "Do you come here often?" / "Yes." | "Do you come here often?" / "Yes, I come here for walks." |

The catalog still has 100 exchanges, 199 turns and the same category allocation. IDs, speaker slots, event conditions and timing remain unchanged. Some legacy IDs (for example, `food-smell` and `farewell-thanks`) now identify revised conversational situations; they are stable identifiers, not literal descriptions of the current lines. See the handoff's `content-review.md` for the complete three-language inventory and per-exchange edit status.
