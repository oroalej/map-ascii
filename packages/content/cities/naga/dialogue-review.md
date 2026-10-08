# Naga ambient dialogue

The catalog contains 104 short, fictional scenes in 15 categories: 42 one-speaker utterances and 62 exchanges. All spoken lines include Central Bikol, English and Tagalog. These are illustrative moments, not quotations from residents or claims about actual businesses, products, fares or timetables.

New scripts are original compositions. [Jon Epstein's *Standard Bikol* (Peace Corps, 1967)](https://files.eric.ed.gov/fulltext/ED018772.pdf) supplies grammatical reference for actor/goal focus, pronouns, questions and demonstratives. [Malcolm Mintz's *Bikol Dictionary* (University of Hawaii Press, 1971)](https://manifold.uhpress.hawaii.edu/projects/bikol-dictionary) supplies lexical reference. Existing catalog entries retain their original sources. A reference supports language forms; it does not attest each authored sentence.

Structural validation checks the exact count, category allocation, translations, speaker slots and duplicate complete scripts. Editorial review checks meaning, concise wording, age suitability and context. Native-speaker review has **not** occurred; idiomatic wording remains a content follow-up. No native-language approval is implied by a source citation.

## Independent expression edit (2026-10-02)

The owner requested spontaneous remarks and emotional expressions without obligatory replies. Exactly the approved 40 IDs now use `delivery: "utterance"`; all remaining entries use `delivery: "exchange"`. Participant slots remain distinct from line count: a vendor can say goodbye alone from slot 1, and a receiver can celebrate a catch from slot 1. All four place reactions are now genuinely solitary observations; the old `talk-visit` ID is retained with the looking mechanism.

Fourteen utterances were rewritten; the other converted scenes retain a self-contained existing line. Examples include happiness during a walk, enjoying a breeze, resting, waiting alone and appreciating a place. No question requiring an answer is left behind by truncation. Functional direction and vendor-order scripts retain complete replies. Existing greeting periods, contextual anchors and weather/event restrictions still apply.

The happiness wording in `plans-done` uses maugma, also found in [Kerwin Orville Tate's original Bikol essay, Solo trip](https://magbikolkita.com/layason-officer/solo-trip/). This establishes written word-family usage, not local spoken approval of the authored sentence. Existing lexical and grammatical references remain applicable. The revised rest wording uses the previously reviewed magpahingalo family. Preserve the owner's Halaton correction.

The renderer can choose a quiet expression instead of speech. These quiet episodes are not extra catalog entries. Walking remarks preserve walking; stationary expressive episodes can use a small gesture or attentive pause. The tracked [catalog](dialogue.json) is the complete current inventory, including delivery, speaker slots and all three languages. The editorial criteria and changes are summarized below.

The weather-warm ID is retained from the plan but describes daylight, because the simulation has no measured temperature. School and weekend dialogue expresses fictional plans without asserting school hours or the current weekday. Common loanwords such as fountain and monumento are intentional. Direction remarks require a nearby mapped anchor and do not provide route instructions.

The tracked [local usage audit](dialogue-usage-review.md) records a decision and evidence for all 100 IDs from the earlier conversational review. Read it alongside the current catalog: its paired-turn descriptions predate the independent-expression edit. The current catalog's 40 utterances and 60 exchanges supersede those historical line counts.

Following the project owner's feedback that "andam" was unfamiliar in their childhood usage, all six occurrences across five exchanges were replaced with context-specific wording. The companion question became "Madya na?" ("Shall we go?"); translations follow the revised meaning. Dictionary attestation alone does not establish locally familiar everyday usage.

The owner corrected "Hulaton" to "Halaton" in "Halaton taka digdi." Preserve this correction in future edits; the English and Tagalog meanings remain unchanged. This feedback covers this wording, not approval of the entire catalog.

## Historical conversational edit (before independent expressions)

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

At this stage, the catalog had 100 scenes and 199 turns with the same category allocation; this count predates the independent-expression edit above. IDs, speaker slots, event conditions and timing were preserved during that conversational pass. Some legacy IDs (for example, `food-smell` and `farewell-thanks`) identify revised situations; they are stable identifiers, not literal descriptions of the current lines. The current three-language inventory is in [dialogue.json](dialogue.json), and the [local usage audit](dialogue-usage-review.md) retains the per-ID editorial decisions and evidence limits.


## Local usage follow-up

A further pass reviewed every exchange against identifiable local speech, Naga-authored writing, regional published Bikol and grammar references. It revised 20 exchanges (25 turns), including the remaining halat-family inconsistencies, deliberate-looking wording and shorter hungry/tired replies. The owner's Halaton correction and preference to avoid andam remain in force.

[The local usage audit](dialogue-usage-review.md) records the evidence, its limits and a retain/revise decision for all 100 IDs. Actual local examples support several word families. None of those sources certifies our complete authored exchanges or establishes how frequently people use them. Independent review of the complete catalog by a Naga speaker remains pending. References are used as language evidence; no news claim or factual detail from those sources is incorporated into the simulation.

## Heat and clearing scenes (2026-10-07)

Four weather IDs bring the current inventory to 104 scenes (42 utterances and 62 exchanges), with weather increasing from eight to twelve; other categories retain their counts. Historical audit totals above describe their original inventories.

- `weather-heat-rest` combines ABANG/INIT (intensifier and heat) with DIGDI/SANA/KITA (here, just, inclusive we) as a brief rest exchange.
- `weather-heat-here` uses the MA- adjective of INIT, also attested as mainit in the LALO NA and MEDIO examples, with DIGDI.
- `weather-clearing-leave` combines MAYO/NA/NIN/URAN (there is none, now, indefinite marker, rain) and SIGE NA (go ahead).
- `weather-clearing-linger` combines DIGDI/PA/AKO (here, still, I) as an independent observation.

Every word was checked against Mintz's 1971 dictionary, downloaded from its University of Hawaii Press Manifold page. Stress marks are omitted following the existing catalog convention; no new spellings are inferred. These are original fictional compositions, with English and Tagalog meanings rather than literal quotations. Native-speaker review remains pending. The proposed fierce-sun and renewed-rain warnings were omitted in favor of these short supported compositions. Heat is the shared dry/high-sun midday rule, not measured temperature; clearing lines belong only to current post-rain shelter countdowns.
