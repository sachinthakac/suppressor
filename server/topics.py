"""Topic definitions: the Laya questions asked about each snippet.

Two questions per snippet, both phrased as "what does this text say" (Laya
handles that far better than "should this be hidden"):

  subject  - choice: is it about the topic, another game, or not a game?
  kind     - choice: is it about what happens *in* the game (spoiler-ish) or
             about the game as a product (release/price/sales)?

The extension turns P(subject=topic) and P(kind=content) into blur decisions.
Phrasings were picked by running eval_topics.py; re-run it after any change.
Add a topic by adding an entry here and a keyword list in extension/topics.js.
"""

TOPICS = {
    "gta6": {
        "name": "GTA VI",
        "label": "GTA 6 (Grand Theft Auto VI)",
    },
}


def build_questions(topic: str) -> dict:
    t = TOPICS[topic]
    return {
        "subject": {
            "type": "choice",
            "instructions": "What is this video title about?",
            "criteria": {
                "topic": t["label"],
                "other_game": "another video game",
                "other": "something that is not a video game",
            },
        },
        "kind": {
            "type": "choice",
            "instructions": "What is this video title about?",
            "criteria": {
                "content": "what happens in the game: story, characters, ending, missions, "
                           "gameplay, map, secrets, trailer details",
                "business": "news about the game: release date, delay, price, sales, "
                            "preorders, company earnings",
            },
        },
    }


def summarise(answers: dict) -> dict:
    return {
        "about": round(float(answers["subject"]["probabilities"]["topic"]), 4),
        "spoiler": round(float(answers["kind"]["probabilities"]["content"]), 4),
    }
