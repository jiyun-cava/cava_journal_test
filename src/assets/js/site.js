// Index (sort, filters, views), the article pane with pinned pictures, contributors, share button
(function () {
  var base = document.body.getAttribute("data-base") || "";
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var norm = function (s) { return (s || "").normalize("NFC").toLowerCase(); };
  var path = function (u) { try { return decodeURI(new URL(u, location.href).pathname).normalize("NFC"); } catch (e) { return u; } };

  // ---- Index: sort (newest/oldest), year, genre, search, and three views.
  var index = document.getElementById("index");
  var list = document.getElementById("rows");
  var rows = list ? Array.prototype.slice.call(list.querySelectorAll(".row")) : [];
  var input = document.getElementById("site-q");
  var form = document.querySelector(".site-search");
  if (index) {
    var none = document.getElementById("rows-none");
    var year = document.getElementById("f-year");
    var genre = document.getElementById("f-genre");
    var sortBtns = Array.prototype.slice.call(index.querySelectorAll("[data-sort]"));
    var viewBtns = Array.prototype.slice.call(index.querySelectorAll("[data-view-btn]"));
    var state = { sort: store.get("cava-sort") === "old" ? "old" : "new", view: store.get("cava-view") || "1" };
    rows.forEach(function (r) { r._q = norm(r.getAttribute("data-q")); r._g = (r.getAttribute("data-genre") || "").split("|"); });

    var apply = function () {
      var terms = norm(input ? input.value.trim() : "").split(/\s+/).filter(Boolean);
      var dir = state.sort === "old" ? 1 : -1, shown = 0;
      rows.sort(function (a, b) { return a.getAttribute("data-date") < b.getAttribute("data-date") ? -dir : dir; });
      rows.forEach(function (r) {
        var ok = (!year.value || r.getAttribute("data-year") === year.value) &&
          (!genre.value || r._g.indexOf(genre.value) !== -1) &&
          terms.every(function (q) { return r._q.indexOf(q) !== -1; });
        r.hidden = !ok;
        if (ok) shown++;
        list.appendChild(r);
      });
      none.hidden = shown > 0;
      sortBtns.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-sort") === state.sort)); });
    };
    var setView = function (v) {
      if (!/^[123]$/.test(v)) v = "1";
      state.view = v;
      index.setAttribute("data-view", v);
      viewBtns.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-view-btn") === v)); });
    };
    sortBtns.forEach(function (b) { b.addEventListener("click", function () { state.sort = b.getAttribute("data-sort"); store.set("cava-sort", state.sort); apply(); }); });
    viewBtns.forEach(function (b) { b.addEventListener("click", function () { setView(b.getAttribute("data-view-btn")); store.set("cava-view", state.view); }); });
    year.addEventListener("change", apply);
    genre.addEventListener("change", apply);
    setView(state.view);

    // The header search filters the list as you type (title, author, genre, then the article text once loaded).
    if (input) {
      var q0 = new URLSearchParams(location.search).get("q");
      if (q0) input.value = q0;
      var ft;
      input.addEventListener("input", function () { clearTimeout(ft); ft = setTimeout(apply, 80); });
      form.addEventListener("submit", function (e) { e.preventDefault(); apply(); });
      fetch(base + "/search-index.json").then(function (r) { return r.json(); }).then(function (data) {
        var text = {};
        data.forEach(function (p) { text[path(base + p.u)] = norm([p.t, p.a, p.x, p.b].join(" ")); });
        rows.forEach(function (r) { var k = path(r.querySelector("a").href); if (text[k]) r._q += " " + text[k]; });
        if (input.value) apply();
      }).catch(function () {});
    }
    apply();
    var cur = list.querySelector('[aria-current="page"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "center" });
  }

  // ---- Pane: on wide screens an article opens beside the list, without leaving the page.
  var pane = document.getElementById("pane");
  var wide = window.matchMedia("(min-width: 900px)");
  var home = base + "/";
  var mark = function (url) {
    var k = url ? path(url) : null;
    rows.forEach(function (r) {
      var a = r.querySelector("a");
      if (k && path(a.href) === k) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  };
  var closePane = function (push) {
    pane.innerHTML = "";
    document.body.classList.remove("has-open");
    mark(null);
    document.title = (document.querySelector('meta[property="og:site_name"]') || {}).content || document.title;
    if (push) history.pushState({}, "", home);
  };
  var seq = 0;
  var openPane = function (url, push) {
    var n = ++seq;
    mark(url); // highlight straight away; the article follows
    pane.classList.add("is-loading");
    fetch(url).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (html) {
      if (n !== seq) return;
      var doc = new DOMParser().parseFromString(html, "text/html");
      var next = doc.getElementById("pane");
      if (!next || !next.querySelector(".article")) throw 0;
      pane.innerHTML = next.innerHTML;
      pane.classList.remove("is-loading");
      document.body.classList.add("has-open");
      document.title = doc.title;
      pane.scrollTop = 0;
      if (push) history.pushState({}, "", url);
      enhance();
    }).catch(function () { if (n === seq) location.href = url; });
  };
  if (pane && index) {
    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !wide.matches) return;
      var a = e.target.closest && e.target.closest("a[data-open], a[data-close]");
      if (!a) return;
      e.preventDefault();
      if (a.hasAttribute("data-close")) closePane(true);
      else if (path(a.href) === path(location.href) && pane.querySelector(".article")) closePane(true); // a second click on the open row closes it
      else openPane(a.href, true);
    });
    window.addEventListener("popstate", function () {
      if (path(location.href) === path(home)) closePane(false); else openPane(location.href, false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && wide.matches && pane.querySelector(".article") && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) closePane(true);
    });
  }

  // ---- Article pictures: on a wide pane they are pinned beside the text, and the picture
  // changes as the paragraph it belongs to reaches the reading line.
  var stageState = null;
  function enhance() {
    stageState = null;
    var art = pane && pane.querySelector(".article");
    if (!art) return;
    var body = art.querySelector(".article__body"), stage = art.querySelector(".article__stage");
    if (!body || !stage) return;
    var slides = [];
    var cover = art.querySelector(".article__cover img");
    if (cover) slides.push({ src: cover.getAttribute("src"), cap: "", mark: null });
    Array.prototype.forEach.call(body.querySelectorAll("img"), function (img) {
      var box = img.closest("figure, h6");
      if (!box) { var p = img.parentElement; box = p && p !== body && !p.textContent.trim() && p.children.length === 1 ? p : img; }
      var gal = box.closest(".ig-gallery");
      var outer = gal && gal.children.length === 1 ? gal : box;
      var cap = box === img ? "" : box.textContent.trim();
      var src = img.getAttribute("src");
      var m = document.createElement("span");
      m.className = "stage-mark";
      outer.parentNode.insertBefore(m, outer);
      outer.classList.add("staged");
      if (slides.length === 1 && slides[0].mark === null && slides[0].src === src) { slides[0].mark = m; slides[0].cap = cap; return; }
      slides.push({ src: src, cap: cap, mark: m });
    });
    if (!slides.length) return;
    slides.forEach(function (s) {
      var f = document.createElement("figure");
      f.className = "stage__slide";
      var im = document.createElement("img");
      im.alt = ""; im.decoding = "async"; im.setAttribute("data-src", s.src);
      f.appendChild(im);
      if (s.cap) { var c = document.createElement("figcaption"); c.textContent = s.cap; f.appendChild(c); }
      stage.appendChild(f);
      s.el = f; s.img = im;
    });
    var count = document.createElement("span");
    count.className = "stage__count";
    stage.appendChild(count);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var st = stageState = { art: art, slides: slides, on: -1, auto: -1 };
    st.show = function (i) {
      if (i === st.on) return;
      st.on = i;
      slides.forEach(function (s, k) {
        s.el.classList.toggle("is-on", k === i);
        if (Math.abs(k - i) <= 1 && !s.img.src) s.img.src = s.img.getAttribute("data-src"); // load the neighbours ahead
      });
      count.textContent = pad(i + 1) + " / " + pad(slides.length);
    };
    st.sync = function () {
      var sticky = art.clientWidth >= 680 && wide.matches;
      art.classList.toggle("is-sticky", sticky);
      if (!sticky) return;
      var box = pane.getBoundingClientRect();
      var line = box.top + pane.clientHeight * 0.45, i = 0;
      slides.forEach(function (s, k) { if (s.mark && s.mark.getBoundingClientRect().top < line) i = k; });
      if (i !== st.auto) { st.auto = i; st.show(i); } // a click (below) holds until the text reaches another picture
    };
    // Click the picture to step through all of them (several can share one spot in the text).
    stage.addEventListener("click", function () { st.show((st.on + 1) % slides.length); });
    st.sync();
  }
  if (pane) {
    var tick = false;
    var onScroll = function () {
      if (tick || !stageState) return;
      tick = true;
      requestAnimationFrame(function () { tick = false; if (stageState) stageState.sync(); });
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    enhance();
  }

  // Away from the index, the header search opens the index filtered (plain form submit to /?q=).

  // ---- Contributors: a name opens a panel over the right half with their articles.
  var panel = document.getElementById("cpanel");
  if (panel) {
    var pname = document.getElementById("cpanel-name");
    var plist = document.getElementById("cpanel-list");
    var links = Array.prototype.slice.call(document.querySelectorAll("[data-contributor]"));
    var open = function (id, push) {
      var a = document.querySelector('[data-contributor="' + id + '"]');
      var posts = document.getElementById(id + "-posts");
      if (!a || !posts) return close(push);
      pname.textContent = a.textContent;
      plist.innerHTML = posts.innerHTML;
      links.forEach(function (l) { l.setAttribute("aria-current", l === a ? "true" : "false"); });
      panel.classList.add("is-open");
      panel.setAttribute("aria-hidden", "false");
      panel.scrollTop = 0;
      if (push) history.replaceState(null, "", "#" + id);
    };
    var close = function (push) {
      panel.classList.remove("is-open");
      panel.setAttribute("aria-hidden", "true");
      links.forEach(function (l) { l.setAttribute("aria-current", "false"); });
      if (push) history.replaceState(null, "", location.pathname + location.search);
    };
    links.forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var id = a.getAttribute("data-contributor");
        if (panel.classList.contains("is-open") && a.getAttribute("aria-current") === "true") close(true);
        else open(id, true);
      });
    });
    panel.querySelector(".cpanel__close").addEventListener("click", function () { close(true); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(true); });
    if (location.hash.length > 1) open(location.hash.slice(1), false);
  }

  // ---- Share button on articles (delegated: the article can be swapped in later)
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-share]");
    if (!btn) return;
    var url = btn.getAttribute("data-url");
    var title = btn.getAttribute("data-title");
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function () {});
      return;
    }
    var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy link"; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {});
  });
})();
