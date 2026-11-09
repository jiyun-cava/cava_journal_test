# Manuscripts

Approved manuscripts, one per post, copied here from the Google Drive
manuscripts folder (`2026 / N월 / 필자 / 원고`) by a scheduled Claude task.
When the matching post appears on @cava.life, or if it already has, the sync
builds the article from the manuscript (text, subheadings, bio, image
captions) with the post's pictures in carousel order, and publishes it.

Per manuscript, any of:
- `<title>.md` + `<title>.comments.json`: the Google Doc as read with its
  comments (`[{ "id", "text" }]`; comments on images are their captions).
- `<title>.docx`: the Doc downloaded as Word (images removed to keep it small).
- `<title>.json`: `{ "docId", "title", "author", "modified", "postTitle", "version", "articleTitle" }`.
  `author` is the name of the Doc's folder. Set `postTitle` when the Doc's
  name differs from the post's title (the first line of its caption).
  Set `version` to a tab name (e.g. "민영 제안") to use only that version of
  the Doc; otherwise the version matching the slides is used.
  Set `articleTitle` when the article's title isn't the Doc's first bold line.
