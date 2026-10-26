// Mobile menu + share button
(function () {
  var toggle = document.querySelector(".menu-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("nav-open")) toggle.click();
    });
  }

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
