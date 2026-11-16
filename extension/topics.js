// Keyword pre-filter, run before Laya so there is no flash of spoiler.
//   strong:    unambiguous names. Always treated as on-topic; Laya only decides
//              spoiler-vs-news (in "spoilers" mode).
//   ambiguous: words that are often about the topic but not always ("Lucia",
//              "Vice City" - also the 2002 game). Blurred instantly, then Laya
//              decides whether it is really on-topic.
// Text with no keyword at all is still sent to Laya, which catches oblique titles.
// Keep server/topics.py in sync when adding a topic.
var SUPPRESSOR_TOPICS = {
  gta6: {
    name: "GTA VI",
    strong: [
      /\bgta\s*-?\s*(6|vi)\b/i,
      /\bgta6\b/i,
      /\bgrand\s+theft\s+auto\s*:?\s*(6|vi)\b/i,
      /#gta6\b/i,
    ],
    ambiguous: [
      /\bleonida\b/i,
      /\bvice\s*city\b/i,
      /\blucia\b/i,
      /\bport\s+gellhorn\b/i,
      /\bkeys\s+of\s+leonida\b/i,
    ],
  },
};
