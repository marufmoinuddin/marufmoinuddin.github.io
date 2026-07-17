(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    initThemeToggle();
    initMobileNav();
    initSearch();
    initToc();
    initReadingProgress();
    initCodeCopy();
    initBlogFilter();
    initSmoothScroll();
  });

  function initThemeToggle() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;

    var icon = btn.querySelector('i');
    var stored = localStorage.getItem('theme');

    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
    }

    if (icon) {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      icon.className = current === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    }

    btn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      if (icon) {
        icon.className = next === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
      }
    });
  }

  function initMobileNav() {
    var toggle = document.getElementById('navToggle');
    var links = document.querySelector('.nav-links');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      links.classList.toggle('open');
    });

    document.addEventListener('click', function (e) {
      if (!links.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
        links.classList.remove('open');
      }
    });

    var navAnchors = links.querySelectorAll('a');
    for (var i = 0; i < navAnchors.length; i++) {
      navAnchors[i].addEventListener('click', function () {
        links.classList.remove('open');
      });
    }
  }

  function initSearch() {
    var btn = document.getElementById('searchBtn');
    var overlay = document.getElementById('searchOverlay');
    var input = document.getElementById('searchInput');
    var results = document.getElementById('searchResults');
    if (!btn || !overlay || !input || !results) return;

    var searchIndex = null;
    var fuse = null;
    var loaded = false;
    var fuseReady = false;
    var debounceTimer = null;

    function loadFuse(callback) {
      if (window.Fuse) {
        callback();
        return;
      }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0';
      s.onload = callback;
      document.head.appendChild(s);
    }

    function loadIndex() {
      if (loaded) return;
      loaded = true;
      fetch('/assets/js/search-index.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          searchIndex = data;
          loadFuse(function () {
            fuse = new Fuse(searchIndex, {
              keys: ['title', 'excerpt', 'tags', 'category'],
              threshold: 0.4,
              distance: 100
            });
            fuseReady = true;
          });
        })
        .catch(function () {});
    }

    function openSearch() {
      loadIndex();
      overlay.classList.add('active');
      input.value = '';
      results.innerHTML = '';
      setTimeout(function () { input.focus(); }, 50);
    }

    function closeSearch() {
      overlay.classList.remove('active');
      input.value = '';
      results.innerHTML = '';
    }

    function performSearch(query) {
      if (!query.trim()) {
        results.innerHTML = '';
        return;
      }
      var matched;
      if (fuseReady && fuse) {
        matched = fuse.search(query).map(function (r) { return r.item; }).slice(0, 20);
      } else if (searchIndex) {
        var q = query.toLowerCase();
        matched = searchIndex.filter(function (item) {
          return (item.title && item.title.toLowerCase().indexOf(q) !== -1) ||
            (item.excerpt && item.excerpt.toLowerCase().indexOf(q) !== -1) ||
            (item.tags && item.tags.some(function (t) { return t.toLowerCase().indexOf(q) !== -1; }));
        }).slice(0, 20);
      } else {
        results.innerHTML = '<div class="search-empty">Loading search index...</div>';
        return;
      }

      if (matched.length === 0) {
        results.innerHTML = '<div class="search-empty">No results found.</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < matched.length; i++) {
        var item = matched[i];
        html += '<a href="' + (item.url || '#') + '" class="search-result-item">' +
          '<div class="search-result-title">' + (item.title || 'Untitled') + '</div>' +
          '<div class="search-result-meta">' + (item.category || '') +
          (item.date ? ' &middot; ' + item.date : '') + '</div></a>';
      }
      results.innerHTML = html;
    }

    btn.addEventListener('click', openSearch);

    var closeBtn = overlay.querySelector('.search-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeSearch);
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('active')) {
        closeSearch();
      }
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        closeSearch();
      }
    });

    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var val = this.value;
      debounceTimer = setTimeout(function () {
        performSearch(val);
      }, 200);
    });
  }

  function initToc() {
    var tocNav = document.getElementById('tocNav');
    var tocWrapper = document.getElementById('tocWrapper');
    if (!tocNav) return;

    var content = document.querySelector('.prose') || document.querySelector('.article-body');
    if (!content) {
      if (tocWrapper) tocWrapper.style.display = 'none';
      return;
    }

    var headings = content.querySelectorAll('h2, h3');
    if (headings.length === 0) {
      if (tocWrapper) tocWrapper.style.display = 'none';
      return;
    }

    var html = '<ul>';
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (!h.id) {
        h.id = h.textContent.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      }
      var tag = h.tagName.toLowerCase();
      html += '<li class="toc-' + tag + '"><a href="#' + h.id + '">' + h.textContent + '</a></li>';
    }
    html += '</ul>';
    tocNav.innerHTML = html;

    var tocLinks = tocNav.querySelectorAll('a');
    var ticking = false;

    function highlightToc() {
      var scrollTop = window.scrollY;
      var current = '';
      for (var j = 0; j < headings.length; j++) {
        var rect = headings[j].getBoundingClientRect();
        if (rect.top <= 120) {
          current = headings[j].id;
        }
      }
      for (var k = 0; k < tocLinks.length; k++) {
        tocLinks[k].classList.remove('active');
        if (tocLinks[k].getAttribute('href') === '#' + current) {
          tocLinks[k].classList.add('active');
        }
      }
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(function () {
          highlightToc();
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  function initReadingProgress() {
    var bar = document.getElementById('progress');
    if (!bar) return;

    var ticking = false;

    function update() {
      var scrollTop = window.scrollY;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight > 0) {
        bar.style.width = (scrollTop / docHeight) * 100 + '%';
      }
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(function () {
          update();
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  function initCodeCopy() {
    var codes = document.querySelectorAll('.prose pre > code');
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      var pre = code.parentElement;
      if (pre.querySelector('.code-copy') || pre.classList.contains('lineno')) continue;

      var btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'Copy';
      pre.style.position = 'relative';
      pre.appendChild(btn);

      (function (button, codeEl) {
        button.addEventListener('click', function () {
          var text = codeEl.textContent;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              button.textContent = 'Copied!';
              setTimeout(function () { button.textContent = 'Copy'; }, 2000);
            });
          } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            button.textContent = 'Copied!';
            setTimeout(function () { button.textContent = 'Copy'; }, 2000);
          }
        });
      })(btn, code);
    }
  }

  function initBlogFilter() {
    var chips = document.querySelectorAll('.chip');
    var posts = document.querySelectorAll('.post-card');
    var searchInput = document.getElementById('blogSearch');

    if (chips.length === 0 || posts.length === 0) return;

    function filterPosts() {
      var activeChip = document.querySelector('.chip.active');
      var category = activeChip ? activeChip.getAttribute('data-category') : 'all';
      var query = searchInput ? searchInput.value.toLowerCase() : '';

      for (var i = 0; i < posts.length; i++) {
        var post = posts[i];
        var catMatch = category === 'all' || post.getAttribute('data-category') === category;
        var textMatch = !query || post.textContent.toLowerCase().indexOf(query) !== -1;
        post.style.display = catMatch && textMatch ? '' : 'none';
      }
    }

    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        for (var j = 0; j < chips.length; j++) {
          chips[j].classList.remove('active');
        }
        this.classList.add('active');
        filterPosts();
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', filterPosts);
    }
  }

  function initSmoothScroll() {
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a[href^="#"]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href === '#') return;
      var target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

})();
