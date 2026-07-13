(function () {
  "use strict";

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function visibleFocusableElements(container) {
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (element) {
      return !element.hidden && element.getAttribute("aria-hidden") !== "true";
    });
  }

  ready(function () {
    var drawer = document.querySelector("#site-drawer[data-site-drawer], [data-site-drawer]");
    var toggles = Array.from(
      document.querySelectorAll("[data-drawer-toggle], [data-nav-toggle]")
    );
    var backdrop = document.querySelector("[data-drawer-backdrop], [data-nav-backdrop]");
    var closeButtons = Array.from(
      document.querySelectorAll("[data-drawer-close], [data-nav-close]")
    );
    var previouslyFocused = null;

    function isMobileLayout() {
      if (!toggles.length) {
        return false;
      }
      return toggles.some(function (toggle) {
        return window.getComputedStyle(toggle).display !== "none";
      });
    }

    function isDrawerOpen() {
      return Boolean(drawer && drawer.classList.contains("is-open"));
    }

    function setDrawerOpen(open, restoreFocus) {
      if (!drawer) {
        return;
      }

      var active = Boolean(open && isMobileLayout());

      if (active) {
        previouslyFocused = document.activeElement;
      }

      drawer.hidden = false;
      drawer.classList.toggle("is-open", active);
      drawer.toggleAttribute("data-open", active);
      drawer.setAttribute("aria-hidden", isMobileLayout() && !active ? "true" : "false");
      if ("inert" in drawer) {
        drawer.inert = isMobileLayout() && !active;
      }
      document.body.classList.toggle("drawer-open", active);
      document.body.classList.toggle("nav-open", active);

      toggles.forEach(function (toggle) {
        toggle.setAttribute("aria-expanded", active ? "true" : "false");
      });

      if (backdrop) {
        backdrop.hidden = !active;
        backdrop.classList.toggle("is-open", active);
        backdrop.setAttribute("aria-hidden", active ? "false" : "true");
      }

      if (active) {
        var focusable = visibleFocusableElements(drawer);
        var initialFocus =
          drawer.querySelector("[data-drawer-close]") || focusable[0] || drawer;
        if (!drawer.hasAttribute("tabindex") && initialFocus === drawer) {
          drawer.setAttribute("tabindex", "-1");
        }
        initialFocus.focus({ preventScroll: true });
      } else {
        if (
          restoreFocus !== false &&
          previouslyFocused &&
          typeof previouslyFocused.focus === "function"
        ) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }
    }

    if (drawer) {
      var startsOpen =
        drawer.classList.contains("is-open") || drawer.hasAttribute("data-open");
      setDrawerOpen(startsOpen, false);

      toggles.forEach(function (toggle) {
        toggle.addEventListener("click", function () {
          setDrawerOpen(!isDrawerOpen());
        });
      });

      closeButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          setDrawerOpen(false);
        });
      });

      if (backdrop) {
        backdrop.addEventListener("click", function () {
          setDrawerOpen(false);
        });
      }

      drawer.addEventListener("click", function (event) {
        var link = event.target.closest("a[href]");
        if (link && isMobileLayout()) {
          setDrawerOpen(false, false);
        }
      });

      window.addEventListener("resize", function () {
        setDrawerOpen(isDrawerOpen(), false);
      });

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && isDrawerOpen()) {
          event.preventDefault();
          setDrawerOpen(false);
          return;
        }

        if (event.key !== "Tab" || !isDrawerOpen()) {
          return;
        }

        var focusable = visibleFocusableElements(drawer);
        if (!focusable.length) {
          event.preventDefault();
          drawer.focus();
          return;
        }

        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }

    document.addEventListener("click", function (event) {
      var close = event.target.closest(
        "[data-message-close], [data-alert-close], [data-dismiss-message], .message-close, .message__close"
      );
      if (!close) {
        return;
      }

      var message = close.closest("[data-message], .message, .alert");
      if (!message) {
        return;
      }

      message.setAttribute("aria-hidden", "true");
      message.remove();
    });
  });
})();
