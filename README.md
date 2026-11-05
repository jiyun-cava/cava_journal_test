# CAVA LIFE — journal site (no Shopify)

A static rebuild of ca-va.life's NOW Journal and MORE Journal, hosted free on
GitHub Pages. New posts on Instagram (@cava.life) become journal articles
automatically.

- Same URLs as Shopify: `/blogs/cavajournal/<handle>`, `/blogs/nowjournal/<handle>`, and the `.atom` feeds
- Home page, two paginated journals, article pages, search, About, sitemap, 404
- `npm run import` copies every existing Shopify article and its images
- A scheduled GitHub Action checks Instagram every 2 hours and publishes new posts

```
site.config.json            ← names, menu, Instagram rules (edit this)
src/posts/<journal>/*.md    ← one file per article (front matter + HTML)
src/media/                  ← images and videos
scripts/import-shopify.mjs  ← one-time migration
scripts/sync-instagram.mjs  ← Instagram → articles
.github/workflows/          ← deploy + token refresh
```

## 1. Run it locally

Requires Node 20+.

```bash
npm install
npm start            # http://localhost:8080 — shows 5 sample posts
npm test             # offline tests (mock Instagram)
```

## 2. Bring your articles over from Shopify

```bash
npm run import -- --dry-run     # list what it found
npm run import -- --limit 3     # try a few
npm run import                  # everything (both journals)
```

By default it reads the public Atom feeds at `ca-va.life/blogs/<blog>.atom`,
which gives published articles. For drafts and tags too, create a custom app
in Shopify admin (Settings → Apps → Develop apps) with the `read_content`
scope and run:

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_... npm run import
```

Images are downloaded (resized to max 2000px) into `src/media/<journal>/<handle>/`,
so the site keeps working after Shopify is cancelled. The sample posts are
deleted automatically on the first successful import. Run the import **before**
cancelling Shopify, then check a few articles with `npm start`.

## 3. Put it on GitHub Pages

On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Then **Actions → Sync Instagram & deploy → Run workflow**.

GitHub Pages is free for **public** repositories. A private repository needs a
paid GitHub plan (Pro, Team or Enterprise) for Pages.

Until the custom domain is set, the site lives at
`https://<you>.github.io/<repo>/`; the workflow handles that sub-folder
automatically.

### Import without a computer

**Actions → Import from Shopify → Run workflow** runs the same import as
`npm run import` on GitHub, commits the articles and publishes the site. Put
`3` in *limit* for a first try, then run it again with *limit* empty.

## 4. Connect Instagram

The account must be a **Business or Creator** account.

1. Go to [developers.facebook.com](https://developers.facebook.com/apps) → **Create app** → type *Business*.
2. Add the product **Instagram** → **API setup with Instagram business login**.
3. Under *Generate access tokens*, click **Add account**, log in as @cava.life, then **Generate token**.
   This is a long-lived token (60 days) with `instagram_business_basic`.
4. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `INSTAGRAM_ACCESS_TOKEN`, value: the token.
5. **Actions → Sync Instagram & deploy → Run workflow** to test it now.

The app can stay in development mode — it only reads your own account.

### Token refresh (so it never expires)

`refresh-token.yml` renews the token every Monday and saves it back into the
secret. GitHub's built-in token can't edit secrets, so add one more:

1. GitHub → your avatar → **Settings → Developer settings → Fine-grained tokens → Generate**
2. Repository access: only this repo. Permissions: **Secrets → Read and write**.
3. Save it as a repository secret named `GH_SECRETS_TOKEN`.

If it ever lapses, generate a new token (step 4.3) and replace the secret.

### How a post becomes an article

Every new post goes through these steps:

1. **Read each slide (needs the `ANTHROPIC_API_KEY` secret).** Claude looks at every carousel image in order and sorts it:
   - **Photo or artwork slide:** kept as an image.
   - **Title slide** (title + handwritten signature): kept as an image. The article title becomes `작가 — 제목`.
   - **Text slide:** transcribed into live text. The slide image is not kept. A sentence cut off at the end of one slide is joined with the next. Source lines like `← 출처: …` become small notes.
   - **Issue number** next to the CAVA *journal* wordmark is saved as `issue`.
2. **Fallback when there's no API key, or reading fails:** only the first image is imported, plus a "본문 준비 중" placeholder for an editor to replace with the text.
3. **Review.** With `"review": "pull-request"` (the default), each batch of new posts opens a pull request. Its description shows the full article: images, then the transcribed text in order. An editor checks it against the post and fixes text in **Files changed → ⋯ → Edit file**. **Merge** publishes; **Close** discards.

The caption is kept under the article. Its first line is the title when there's no title slide.

```
홍길동 — 어느 오후의 산책          ← caption first line = title if there is no title slide
첫 단락…                            ← kept under the article
#nowjournal                         ← chooses the journal
```

#### Turning on slide reading

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) → **API keys**, and add a little credit under **Billing**. Each post costs one small image request per slide.
2. Add it as a repository secret named `ANTHROPIC_API_KEY`.
3. In **Settings → Actions → General → Workflow permissions**, tick **Allow GitHub Actions to create and approve pull requests**. Without it, the review pull request can't be opened.

Settings in `site.config.json → instagram`:

| Key | What it does |
|---|---|
| `importAfter` | Posts before this date are ignored, so the old feed isn't duplicated on top of the migrated articles. Use *Run workflow → backfill* to ignore it once. |
| `routeByHashtag` | `#nowjournal` / `#cavaweekly` → NOW Journal, `#morejournal` → MORE Journal |
| `defaultJournal` | Where posts without a routing tag go (`cavajournal`) |
| `requireHashtag` | Set e.g. `"#journal"` to only import posts carrying that tag. `null` = every post |
| `skipHashtags` | Posts with these tags are never imported (`#notjournal`) |
| `removeRoutingHashtags` | Hide the routing tags from the article text |
| `maxVideoMB` | Larger videos show the poster frame linking to Instagram instead |
| `review` | `"pull-request"`: new posts wait for an editor to merge. `"publish"`: they go live straight away |
| `splitSlides` | `false` turns slide reading off (every post arrives as "first image + text needed") |
| `visionModel` | Claude model used to read slides |
| `includeCaption` | `false` leaves the Instagram caption off the article |

Reels/videos are stored and played on the page. Each article links back to
the Instagram post. Edits made later on Instagram are not re-synced; edit the
`.md` file instead. Posts already sent for review are listed in
`instagram-state.json`, so a closed (discarded) pull request is not re-created.
To bring one back, remove its id from that file.

To review before publishing, add `draft: true` to a post: drafts appear in
`npm start` but not on the live site.

## 5. Switch the domain from Shopify

`src/static/CNAME` is set to `www.ca-va.life`.

1. GitHub → Settings → Pages → Custom domain: `www.ca-va.life` → check **Enforce HTTPS** once available.
2. At your DNS provider (it may currently point at Shopify):
   - `www` → **CNAME** → `<you>.github.io`
   - apex `ca-va.life` → **A** records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
3. In Shopify, remove the domain (Settings → Domains) before cancelling the plan.

## Writing an article by hand

Create `src/posts/cavajournal/my-article.md`:

```markdown
---
title: "이름 — 제목"
date: "2026-11-01T10:00:00+09:00"
cover: "/media/cavajournal/my-article/01.jpg"
---
<p>본문…</p>
<h6><img src="/media/cavajournal/my-article/02.jpg">이미지 캡션</h6>
```

Commit and push — it's live in about a minute.

## What changed from the Shopify site

- No cart, customer login, or checkout (the journals didn't use them).
- The language switcher is gone; articles were Korean-only. Can be added back.
- Old `?page=2` links redirect to `/page/2/`.
- Logo is downloaded by the importer to `src/media/brand/logo.png`; until then the header shows the wordmark text.
