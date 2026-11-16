// Per-site description of what a "content item" is and how to read its text.
// `items`: CSS selector for cards/posts/comments to judge individually.
// `text(el)`: the snippet sent to the classifier (keep it short: titles beat full text).
// `player`: optional; the main video player, covered when the page itself is a spoiler.
// `pageTitle()`: optional; text describing the current page (e.g. the video being watched).

function suppressorFirstText(el, selectors) {
  for (const s of selectors) {
    const n = el.querySelector(s);
    const t = n && (n.getAttribute("title") || n.textContent || "").trim();
    if (t) return t;
  }
  return "";
}

var SUPPRESSOR_SITES = [
  {
    match: /(^|\.)youtube\.com$/,
    items: [
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-playlist-renderer",
      "ytd-reel-item-renderer",
      "ytm-shorts-lockup-view-model",
      "yt-lockup-view-model",
      "ytd-notification-renderer",
      "ytd-comment-view-model",
      "ytd-post-renderer",
      ".ytp-videowall-still",
      ".ytp-ce-element",
    ].join(","),
    text(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === "ytd-comment-view-model") {
        return suppressorFirstText(el, ["#content-text"]).slice(0, 400);
      }
      if (tag === "ytd-post-renderer") {
        return suppressorFirstText(el, ["#content-text", "#home-content-text"]).slice(0, 400);
      }
      const title = suppressorFirstText(el, [
        "#video-title",
        "a#video-title-link",
        "h3 a[title]",
        ".yt-lockup-metadata-view-model__title",
        ".yt-lockup-metadata-view-model-wiz__title",
        "h3",
        ".ytp-videowall-still-info-title",
        ".ytp-ce-video-title",
        ".shortsLockupViewModelHostOutsideMetadataTitle",
        "#message",
      ]) || (el.getAttribute("aria-label") || "");
      const channel = suppressorFirstText(el, ["ytd-channel-name #text", "#channel-name #text", ".yt-content-metadata-view-model__metadata-text"]);
      return channel ? `${title} — ${channel}` : title;
    },
    player: "#movie_player, ytd-reel-video-renderer[is-active] #player-container",
    pageTitle() {
      if (location.pathname === "/watch" || location.pathname.startsWith("/shorts/")) {
        const h = document.querySelector("ytd-watch-metadata h1, #title h1, ytd-reel-video-renderer[is-active] h2");
        const t = (h && h.textContent.trim()) || document.title.replace(/ - YouTube$/, "");
        return t;
      }
      return "";
    },
    // Elements that should be blurred together with the player when the page is a spoiler.
    pageExtras: "ytd-watch-metadata, #description, ytd-reel-video-renderer[is-active] .metadata-container",
  },
  {
    match: /(^|\.)reddit\.com$/,
    items: "shreddit-post, shreddit-comment, faceplate-tracker[noun='post'], .thing.link, .thing.comment",
    text(el) {
      const t = el.getAttribute("post-title");
      if (t) return t;
      return suppressorFirstText(el, ["a.title", "[slot='title']", "[slot='comment']", ".md", "p"]).slice(0, 400);
    },
  },
  {
    match: /(^|\.)(x|twitter)\.com$/,
    items: "article[data-testid='tweet']",
    text(el) {
      return suppressorFirstText(el, ["[data-testid='tweetText']"]).slice(0, 400);
    },
  },
];
