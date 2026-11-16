"""Topic definitions: the Laya questions asked about each snippet.

Two questions per snippet, both phrased as "what does this text say" (Laya
handles that far better than "should this be hidden"):

  subject  - choice: is it about the topic, another game, or not a game?
  kind     - choice: story spoiler / gameplay / trailer / news / music / opinion.
             "spoiler" = P(story_spoiler) + P(gameplay); trailers, news, music
             and memes are deliberately not spoilers.

The extension turns P(subject=topic) and the spoiler score into blur decisions.
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
            "instructions": "What kind of video is this?",
            "criteria": {
                "story_spoiler": "reveals the plot, ending, deaths or twists",
                "gameplay": "shows playing the game: let's play, walkthrough, missions, guide, "
                            "map, leaked footage",
                "trailer": "a trailer, or reaction to or breakdown of a trailer",
                "news": "news about release date, delay, price, sales, preorders, earnings, platforms",
                "music": "music, soundtrack or songs",
                "opinion": "meme, joke, opinion or hype",
            },
        },
    }


def summarise(answers: dict) -> dict:
    return {
        "about": round(float(answers["subject"]["probabilities"]["topic"]), 4),
        "spoiler": round(float(answers["kind"]["probabilities"]["story_spoiler"]
                               + answers["kind"]["probabilities"]["gameplay"]), 4),
    }
