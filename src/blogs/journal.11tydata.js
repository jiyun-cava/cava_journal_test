// Data for journal.njk: one paginated listing per journal
//   /blogs/<journal>/  and  /blogs/<journal>/page/2/ ...
// `before` turns the full post list into page chunks for every journal.
export default {
  layout: "layouts/base.njk",
  pagination: {
    data: "collections.allPosts",
    size: 1,
    alias: "chunk",
    before(all, fullData) {
      const { journals, postsPerPage: per } = fullData.site;
      const chunks = [];
      for (const j of journals) {
        const posts = all.filter((p) => p.data.journal === j.key);
        const total = Math.max(1, Math.ceil(posts.length / per));
        for (let page = 1; page <= total; page++) {
          chunks.push({ key: j.key, title: j.title, page, total, posts: posts.slice((page - 1) * per, page * per) });
        }
      }
      return chunks;
    },
  },
  permalink: (data) => `/blogs/${data.chunk.key}/${data.chunk.page > 1 ? `page/${data.chunk.page}/` : ""}`,
  eleventyComputed: { title: (data) => data.chunk.title },
};
