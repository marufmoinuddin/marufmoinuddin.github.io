/**
 * Site JS — nav, theme, search, reading progress, TOC, code copy
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    initMobileNav();
    initScrollHandler();
    initSearch();
    initTocToggle();
    initCodeCopy();
    initThemeToggle();
    initSmoothScroll();
    initBlogFilter();
  });

  function initThemeToggle() {
    var btn = document.getElementById('navThemeBtn');
    if (!btn) return;

    var icon = btn.querySelector('i');
    var currentTheme = document.documentElement.getAttribute('data-theme');
    if (icon) {
      icon.className = currentTheme === 'light' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }

    btn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      if (icon) {
        icon.className = next === 'light' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      }
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute('content', next === 'light' ? '#f7f5f1' : '#0a0a0b');
      }
    });
  }

  function initMobileNav() {
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      if (!links.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    links.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  function initScrollHandler() {
    var bar = document.getElementById('readingProgress');
    var tocLinks = null;
    var tocHeadings = null;
    var ticking = false;

    var tocBody = document.getElementById('tocBody');
    if (tocBody) {
      tocLinks = tocBody.querySelectorAll('a');
      var content = document.getElementById('articleContent');
      if (content) {
        tocHeadings = content.querySelectorAll('h2, h3');
      }
    }

    if (!bar && (!tocLinks || tocLinks.length === 0)) return;

    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(function () {
          var scrollTop = window.scrollY;

          if (bar) {
            var docHeight = document.documentElement.scrollHeight - window.innerHeight;
            if (docHeight > 0) {
              bar.style.width = (scrollTop / docHeight) * 100 + '%';
            }
          }

          if (tocLinks && tocHeadings && tocLinks.length > 0) {
            var current = '';
            tocHeadings.forEach(function (h) {
              if (h.getBoundingClientRect().top <= 100) {
                current = '#' + h.id;
              }
            });
            tocLinks.forEach(function (link) {
              link.classList.toggle('active', link.getAttribute('href') === current);
            });
          }

          ticking = false;
        });
        ticking = true;
      }
    });
  }

  var searchIndex = [];
  var fuse = null;
  var searchLoaded = false;

  function initSearch() {
    var searchBtn = document.getElementById('navSearchBtn');
    var overlay = document.getElementById('searchOverlay');
    var input = document.getElementById('searchInput');
    var closeBtn = document.getElementById('searchClose');
    var results = document.getElementById('searchResults');

    if (!searchBtn || !overlay || !input || !closeBtn || !results) return;

    function loadSearchIndex() {
      if (searchLoaded) return;
      searchLoaded = true;
      fetch('/assets/js/search-index.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          searchIndex = data || [];
          if (typeof Fuse !== 'undefined' && searchIndex.length) {
            fuse = new Fuse(searchIndex, {
              keys: ['title', 'excerpt', 'tags'],
              threshold: 0.4,
              distance: 100
            });
          }
        })
        .catch(function () {});
    }

    function openSearch() {
      loadSearchIndex();
      overlay.classList.add('active');
      input.value = '';
      results.innerHTML = '<div class="search-empty">Start typing to search…</div>';
      setTimeout(function () { input.focus(); }, 50);
    }

    function closeSearch() {
      overlay.classList.remove('active');
    }

    searchBtn.addEventListener('click', openSearch);
    closeBtn.addEventListener('click', closeSearch);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSearch();
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (overlay.classList.contains('active')) closeSearch();
        else openSearch();
      }
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSearch();
    });

    var debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        performSearch(input.value, results);
      }, 180);
    });
  }

  function performSearch(query, resultsEl) {
    if (!query.trim()) {
      resultsEl.innerHTML = '<div class="search-empty">Start typing to search…</div>';
      return;
    }

    if (!searchIndex.length) {
      resultsEl.innerHTML = '<div class="search-empty">No posts to search yet.</div>';
      return;
    }

    var matched;
    if (fuse) {
      matched = fuse.search(query).map(function (r) { return r.item; }).slice(0, 20);
    } else {
      var q = query.toLowerCase();
      matched = searchIndex.filter(function (item) {
        return item.title.toLowerCase().includes(q) ||
          (item.excerpt && item.excerpt.toLowerCase().includes(q)) ||
          (item.tags && item.tags.some(function (t) { return t.toLowerCase().includes(q); }));
      }).slice(0, 20);
    }

    if (!matched.length) {
      resultsEl.innerHTML = '<div class="search-empty">No results found.</div>';
      return;
    }

    var html = '';
    matched.forEach(function (item) {
      html += '<a href="' + item.url + '" class="search-result-item">' +
        '<div class="search-result-title">' + item.title + '</div>' +
        '<div class="search-result-meta">' + (item.date || '') + '</div>' +
        '</a>';
    });
    resultsEl.innerHTML = html;
  }

  function initTocToggle() {
    var toggle = document.getElementById('tocToggle');
    var body = document.getElementById('tocBody');
    var wrapper = document.getElementById('tocWrapper');
    if (!toggle || !body) return;

    toggle.addEventListener('click', function () {
      body.classList.toggle('collapsed');
      if (wrapper) wrapper.classList.toggle('collapsed');
      var icon = toggle.querySelector('i');
      if (icon) {
        icon.className = body.classList.contains('collapsed')
          ? 'fa-solid fa-chevron-down'
          : 'fa-solid fa-chevron-up';
      }
    });

    generateTOC();
  }

  function generateTOC() {
    var content = document.getElementById('articleContent');
    var tocBody = document.getElementById('tocBody');
    if (!content || !tocBody) return;

    var headings = content.querySelectorAll('h2, h3');
    if (!headings.length) {
      var wrapper = document.getElementById('tocWrapper');
      if (wrapper) wrapper.style.display = 'none';
      return;
    }

    var html = '<ul>';
    headings.forEach(function (h) {
      var tag = h.tagName.toLowerCase();
      var id = h.id || h.textContent.toLowerCase().replace(/[^\w]+/g, '-');
      h.id = id;
      html += '<li class="' + tag + '_nav"><a href="#' + id + '">' + h.textContent + '</a></li>';
    });
    html += '</ul>';
    tocBody.innerHTML = html;
  }

  function initCodeCopy() {
    document.querySelectorAll('.article-content pre > code').forEach(function (code) {
      var pre = code.parentElement;
      if (pre.classList.contains('lineno') || pre.querySelector('.code-copy-btn')) return;

      var btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.type = 'button';
      btn.textContent = 'Copy';
      pre.style.position = 'relative';
      pre.appendChild(btn);

      btn.addEventListener('click', function () {
        var text = code.textContent;
        var done = function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
        };

        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(done);
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        }
      });
    });
  }

  function initSmoothScroll() {
    document.addEventListener('click', function (e) {
      var target = e.target.closest('a[href^="#"]');
      if (!target) return;
      var href = target.getAttribute('href');
      if (!href || href === '#') return;
      var el = document.querySelector(href);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function initBlogFilter() {
    var posts = document.querySelectorAll('.post-card');
    var searchInput = document.getElementById('blogSearch');
    if (!searchInput || !posts.length) return;

    searchInput.addEventListener('input', function () {
      var q = this.value.toLowerCase();
      posts.forEach(function (post) {
        var match = !q || post.textContent.toLowerCase().includes(q);
        post.style.display = match ? '' : 'none';
      });
    });
  }
})();
