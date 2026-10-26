// Client-side search over /search-index.json (works for Korean without tokenizing).
(function () {
  var input = document.getElementById("q");
  var list = document.getElementById("search-results");
  var status = document.getElementById("search-status");
  if (!input) return;

  var index = null;
  var norm = function (s) { return (s || "").normalize("NFC").toLowerCase(); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var mark = function (text, terms) {
    var out = esc(text);
    terms.forEach(function (t) {
      if (!t) return;
      out = out.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), function (m) { return "<mark>" + m + "</mark>"; });
    });
    return out;
  };

  var base = document.body.getAttribute("data-base") || "";
  fetch(base + "/search-index.json").then(function (r) { return r.json(); }).then(function (data) {
    index = data.map(function (p) { p._t = norm(p.t + " " + p.a); p._b = norm(p.b + " " + p.x); return p; });
    var q = new URLSearchParams(location.search).get("q");
    if (q) { input.value = q; }
    run();
  });

  function run() {
    if (!index) return;
    var q = norm(input.value.trim());
    var terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) { list.innerHTML = ""; status.textContent = index.length + " articles"; return; }
    var hits = [];
    index.forEach(function (p) {
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var inT = p._t.indexOf(terms[i]) !== -1, inB = p._b.indexOf(terms[i]) !== -1;
        if (!inT && !inB) return;
        score += inT ? 10 : 1;
      }
      hits.push({ p: p, s: score });
    });
    hits.sort(function (a, b) { return b.s - a.s; });
    status.textContent = hits.length + (hits.length === 1 ? " result" : " results");
    list.innerHTML = hits.slice(0, 60).map(function (h) {
      var p = h.p;
      return '<li><a href="' + base + p.u + '"><strong>' + mark(p.t, terms) + "</strong><small>" + esc(p.j) + " · " + esc(p.d) + "</small><p>" + mark(p.x, terms) + "</p></a></li>";
    }).join("");
    var url = new URL(location.href);
    url.searchParams.set("q", input.value.trim());
    history.replaceState(null, "", url);
  }

  var t;
  input.addEventListener("input", function () { clearTimeout(t); t = setTimeout(run, 120); });
})();
