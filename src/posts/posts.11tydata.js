// Applies to every article under src/posts/<journal>/<handle>.md
// URLs match the old Shopify ones: /blogs/<journal>/<handle>/
export default {
  layout: "layouts/article.njk",
  eleventyComputed: {
    // Genres: `genre: ["Music"]` in a post's front matter wins; otherwise src/_data/genreMap.json (by handle).
    genreList: (data) => {
      const own = [].concat(data.genre || []).filter(Boolean);
      if (own.length) return own;
      const handle = String(data.handle || data.page.fileSlug).normalize("NFC");
      return (data.genreMap || {})[handle] || [];
    },
    journal: (data) => data.journal || data.page.filePathStem.split("/")[2],
    permalink: (data) => {
      const journal = data.journal || data.page.filePathStem.split("/")[2];
      const handle = data.handle || data.page.fileSlug;
      return `/blogs/${journal}/${handle}/`;
    },
  },
};
