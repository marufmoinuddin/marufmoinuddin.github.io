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
    initFeaturedSlideshow();
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

      var favicon = document.getElementById('siteFavicon');
      if (favicon) {
        favicon.href = next === 'light'
          ? '/img/favicon-pen-light.svg'
          : '/img/favicon-pen-dark.svg';
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
      fetch('/assets/js/search-index.json?v=' + Date.now())
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
    document.querySelectorAll('.article-content pre').forEach(function (pre) {
      var code = pre.querySelector('code');
      if (!code) return;
      if (pre.classList.contains('lineno')) return;

      // avoid duplicate wrappers
      if (pre.closest('.code-wrapper')) return;

      // detect language from ancestor class like 'language-bash'
      var lang = '';
      var el = pre.parentElement;
      while (el) {
        if (el.className) {
          var m = (el.className || '').match(/\blanguage-([a-zA-Z0-9_-]+)\b/);
          if (m) { lang = m[1]; break; }
        }
        el = el.parentElement;
      }
      if (!lang && code.className) {
        var codeMatch = code.className.match(/\blanguage-([a-zA-Z0-9_-]+)\b/);
        if (codeMatch) lang = codeMatch[1];
      }

      // create wrapper and header
      var wrapper = document.createElement('div');
      wrapper.className = 'code-wrapper';

      var header = document.createElement('div');
      header.className = 'code-header';

      var langSpan = document.createElement('span');
      langSpan.className = 'code-lang';
      langSpan.textContent = lang || 'code';
      header.appendChild(langSpan);

      var btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
      header.appendChild(btn);

      // move pre into wrapper and insert header
      pre.parentElement.insertBefore(wrapper, pre);
      wrapper.appendChild(header);

      // Build compact row-based layout: line number gutter + wrapped code line
      try {
        var rougeCodeTd = code.querySelector('td.rouge-code');
        var sourcePre = null;
        if (rougeCodeTd) {
          sourcePre = rougeCodeTd.querySelector('pre');
        } else {
          sourcePre = code.querySelector('pre') || code;
        }

        var rawHtml = sourcePre ? sourcePre.innerHTML : code.innerHTML;
        var lines = rawHtml.split('\n');

        // Remove trailing blank line for tighter blocks.
        if (lines.length > 1 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }

        var block = document.createElement('div');
        block.className = 'code-block';

        lines.forEach(function (ln, idx) {
          var row = document.createElement('div');
          row.className = 'code-row';

          var lineNum = document.createElement('span');
          lineNum.className = 'line-num';
          lineNum.textContent = String(idx + 1);

          var lineDiv = document.createElement('span');
          lineDiv.className = 'code-line';
          lineDiv.innerHTML = ln || '&nbsp;';

          row.appendChild(lineNum);
          row.appendChild(lineDiv);
          block.appendChild(row);
        });

        while (pre.firstChild) pre.removeChild(pre.firstChild);
        pre.appendChild(block);
      } catch (e) {
        // Fall back to original markup if transformation fails.
      }

      wrapper.appendChild(pre);

      btn.addEventListener('click', function () {
        var text = '';
        var linesNodes = wrapper.querySelectorAll('.code-row .code-line');
        if (linesNodes && linesNodes.length) {
          var parts = [];
          linesNodes.forEach(function (ln) {
            parts.push(ln.innerText.replace(/\u00A0/g, ' '));
          });
          text = parts.join('\n');
        } else {
          var rougeCodeTd = code.querySelector('td.rouge-code');
          if (rougeCodeTd) {
            var innerPre = rougeCodeTd.querySelector('pre');
            text = innerPre ? innerPre.textContent : rougeCodeTd.textContent;
          } else {
            var innerPre = code.querySelector('pre');
            text = innerPre ? innerPre.textContent : code.textContent;
          }
        }

        text = text.replace(/\r\n/g, '\n');

        var done = function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
        };

        function fallbackCopy(str) {
          var ta = document.createElement('textarea');
          ta.value = str;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
        }

        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        } else {
          fallbackCopy(text);
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

  /* --- Featured slideshow --- */
  function initFeaturedSlideshow() {
    var track = document.getElementById('slideshowTrack');
    var dots = document.getElementById('slideshowDots');
    if (!track || !dots) return;

    var slides = track.querySelectorAll('.slideshow-slide');
    var dotBtns = dots.querySelectorAll('.slideshow-dot');
    if (!slides.length) return;

    var current = 0;
    var interval = 5000; // 5 seconds
    var timer = null;

    function goTo(index) {
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      dotBtns.forEach(function (d) { d.classList.remove('active'); });
      dotBtns[index].classList.add('active');
      current = index;
    }

    function goNext() {
      var next = (current + 1) % slides.length;
      goTo(next);
    }

    function startTimer() {
      stopTimer();
      timer = setInterval(goNext, interval);
    }

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    // Show first slide
    goTo(0);
    startTimer();

    // Dot click navigation
    dotBtns.forEach(function (dot) {
      dot.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-index'), 10);
        if (idx !== current) {
          goTo(idx);
          startTimer(); // reset timer on manual nav
        }
      });
    });

    // Pause on hover / touch
    var container = document.getElementById('featuredSlideshow');
    if (container) {
      container.addEventListener('mouseenter', stopTimer);
      container.addEventListener('mouseleave', startTimer);
      container.addEventListener('touchstart', stopTimer, { passive: true });
      container.addEventListener('touchend', startTimer, { passive: true });
    }
  }
})();
