// Home wall (masonry + live filter), header search, share button
(function () {
  // ---- Masonry: each cover goes in the shortest column, in order (newest first, left to right).
  var wall = document.getElementById("wall");
  var tiles = wall ? Array.prototype.slice.call(wall.querySelectorAll(".tile")) : [];
  var cols = 0;
  function count() {
    var w = window.innerWidth;
    return w >= 1300 ? 5 : w >= 1000 ? 4 : w >= 720 ? 3 : 2;
  }
  function ratio(t) {
    var m = (t.style.getPropertyValue("--r") || "4 / 5").split("/");
    return (+m[1] || 5) / (+m[0] || 4);
  }
  function layout(force) {
    if (!wall) return;
    var n = count();
    if (n === cols && !force) return;
    cols = n;
    var columns = [], heights = [];
    for (var i = 0; i < n; i++) {
      var c = document.createElement("div");
      c.className = "wall__col";
      columns.push(c); heights.push(0);
    }
    tiles.forEach(function (t) {
      if (t.hidden) { columns[0].appendChild(t); return; }
      var k = heights.indexOf(Math.min.apply(null, heights));
      columns[k].appendChild(t);
      heights[k] += ratio(t) + 0.06; // + gap
    });
    wall.innerHTML = "";
    columns.forEach(function (c) { wall.appendChild(c); });
    wall.classList.add("is-laid");
  }
  if (wall) {
    layout(true);
    var rt;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { layout(false); }, 120); });
  }

  // ---- Header search: on the home page the covers are filtered right there, as you type
  // (title, author and the article text). Elsewhere, Enter opens the home page filtered.
  var form = document.querySelector(".site-search");
  var input = document.getElementById("site-q");
  if (input && wall) {
    var none = document.getElementById("wall-none");
    var norm = function (s) { return (s || "").normalize("NFC").toLowerCase(); };
    var text = {};
    tiles.forEach(function (t) { t._q = norm(t.getAttribute("data-q")); });
    var base = document.body.getAttribute("data-base") || "";
    fetch(base + "/search-index.json").then(function (r) { return r.json(); }).then(function (data) {
      var key = function (u) { try { return decodeURI(u.replace(base, "")); } catch (e) { return u; } };
      data.forEach(function (p) { text[key(p.u)] = norm([p.t, p.a, p.x, p.b].join(" ")); });
      tiles.forEach(function (t) { var a = t.querySelector("a"); var k = a && key(a.getAttribute("href")); if (k && text[k]) t._q = text[k]; });
      if (input.value) filter();
    }).catch(function () {});
    var filter = function () {
      var terms = norm(input.value.trim()).split(/\s+/).filter(Boolean);
      var shown = 0;
      tiles.forEach(function (t) {
        var ok = terms.every(function (q) { return t._q.indexOf(q) !== -1; });
        t.hidden = !ok;
        if (ok) shown++;
      });
      if (none) none.hidden = shown > 0;
      layout(true);
      var url = new URL(location.href);
      if (input.value.trim()) url.searchParams.set("q", input.value.trim()); else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    };
    var q0 = new URLSearchParams(location.search).get("q");
    if (q0) { input.value = q0; filter(); }
    var ft;
    input.addEventListener("input", function () { clearTimeout(ft); ft = setTimeout(filter, 80); });
    form.addEventListener("submit", function (e) { e.preventDefault(); filter(); input.blur(); });
  }

  // ---- Share button on articles
  document.querySelectorAll("[data-share]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var url = btn.getAttribute("data-url");
      var title = btn.getAttribute("data-title");
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function () {});
        return;
      }
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy link"; }, 1800); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {});
    });
  });
})();
