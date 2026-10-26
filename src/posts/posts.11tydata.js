// Applies to every article under src/posts/<journal>/<handle>.md
// URLs match the old Shopify ones: /blogs/<journal>/<handle>/
export default {
  layout: "layouts/article.njk",
  eleventyComputed: {
    journal: (data) => data.journal || data.page.filePathStem.split("/")[2],
    permalink: (data) => {
      const journal = data.journal || data.page.filePathStem.split("/")[2];
      const handle = data.handle || data.page.fileSlug;
      return `/blogs/${journal}/${handle}/`;
    },
  },
};
