# Manuscripts

Approved manuscripts, one per post, saved here automatically from the CAVA
journal manuscript Sheet. When the matching post appears on @cava.life, the
sync builds the article from the manuscript (text, subheadings, bio, image
captions) with the post's pictures in carousel order, and publishes it.

- `<title>.md`: the Google Doc's text (as read with its comments).
- `<title>.comments.json`: the Doc's comments, `[{ "id", "text" }]`; comments on
  images are their captions.
- Optional `<title>.json`: `{ "author": "지혜진", "doc": "<Google Doc link>" }`.

The post is matched by title: the manuscript's title must be the first line of
the Instagram caption.
