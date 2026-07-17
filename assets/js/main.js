/**
 * Main JavaScript for Moin Uddin Ahmed's site
 * Handles: navigation, search, reading progress, theme toggle
 */

(function() {
  'use strict';

  // --- DOM Ready ---
  document.addEventListener('DOMContentLoaded', function() {

    // Mobile nav toggle
    initMobileNav();

    // Scroll handler (progress bar + TOC highlight)
    initScrollHandler();

    // Search overlay
    initSearch();

    // TOC toggle
    initTocToggle();

    // Doc sidebar toggle
    initDocSidebar();

    // Code copy buttons
    initCodeCopy();

    // Theme toggle (dark/light mode)
    initThemeToggle();

    // Smooth scroll for anchor links
    initSmoothScroll();

    // Blog category filtering
    initBlogFilter();

  });

  // --- Dark/Light Mode Toggle ---
  function initThemeToggle() {
    var btn = document.getElementById('navThemeBtn');
    if (!btn) return;

    var icon = btn.querySelector('i');
    // Sync icon with current theme
    var currentTheme = document.documentElement.getAttribute('data-theme');
    if (icon) {
      icon.className = currentTheme === 'light' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }

    btn.addEventListener('click', function() {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      if (icon) {
        icon.className = next === 'light' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      }
    });
  }

  // --- Mobile Navigation ---
  function initMobileNav() {
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');

    if (!toggle || !links) return;

    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      links.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', function(e) {
      if (!links.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
        links.classList.remove('open');
      }
    });

    // Close on link click
    links.querySelectorAll('a').forEach(function(link) {
      link.addEventListener('click', function() {
        links.classList.remove('open');
      });
    });
  }

  // --- Scroll handler (RAF-throttled) ---
  function initScrollHandler() {
    var bar = document.getElementById('readingProgress');
    var tocLinks = null;
    var tocHeadings = null;
    var ticking = false;

    // Collect TOC elements if they exist
    var tocBody = document.getElementById('tocBody');
    if (tocBody) {
      tocLinks = tocBody.querySelectorAll('a');
      var content = document.getElementById('articleContent') || document.getElementById('docContent');
      if (content) {
        tocHeadings = content.querySelectorAll('h2, h3');
      }
    }

    if (!bar && (!tocLinks || tocLinks.length === 0)) return;

    window.addEventListener('scroll', function() {
      if (!ticking) {
        requestAnimationFrame(function() {
          var scrollTop = window.scrollY;

          // Reading progress
          if (bar) {
            var docHeight = document.documentElement.scrollHeight - window.innerHeight;
            if (docHeight > 0) {
              bar.style.width = (scrollTop / docHeight) * 100 + '%';
            }
          }

          // TOC active highlight
          if (tocLinks && tocHeadings && tocLinks.length > 0) {
            var current = '';
            tocHeadings.forEach(function(h) {
              if (h.getBoundingClientRect().top <= 100) {
                current = '#' + h.id;
              }
            });
            tocLinks.forEach(function(link) {
              link.classList.remove('active');
              if (link.getAttribute('href') === current) {
                link.classList.add('active');
              }
            });
          }

          ticking = false;
        });
        ticking = true;
      }
    });
  }

  // --- Search ---
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

    // Load search index (lazy — only when search is first opened)
    function loadSearchIndex() {
      if (searchLoaded) return;
      searchLoaded = true;
      fetch('/assets/js/search-index.json')
        .then(function(res) { return res.json(); })
        .then(function(data) {
          searchIndex = data;
          fuse = new Fuse(data, {
            keys: ['title', 'excerpt', 'tags'],
            threshold: 0.4,
            distance: 100
          });
        })
        .catch(function() {
          // Search index not available
        });
    }

    // Open search
    searchBtn.addEventListener('click', function() {
      loadSearchIndex();
      overlay.classList.add('active');
      input.value = '';
      results.innerHTML = '<div class="search-empty">Start typing to search...</div>';
      setTimeout(function() { input.focus(); }, 100);
    });

    // Close search
    closeBtn.addEventListener('click', function() {
      overlay.classList.remove('active');
    });

    // Close on ESC
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        overlay.classList.remove('active');
      }
    });

    // Close on overlay click
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        overlay.classList.remove('active');
      }
    });

    // Search input handler
    var debounceTimer;
    input.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() {
        performSearch(input.value, results);
      }, 200);
    });
  }

  function performSearch(query, resultsEl) {
    if (!query.trim() || searchIndex.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">Start typing to search...</div>';
      return;
    }

    var matched;
    if (fuse) {
      matched = fuse.search(query).map(function(r) { return r.item; }).slice(0, 20);
    } else {
      var q = query.toLowerCase();
      matched = searchIndex.filter(function(item) {
        return item.title.toLowerCase().includes(q) ||
               (item.excerpt && item.excerpt.toLowerCase().includes(q)) ||
               (item.tags && item.tags.some(function(t) { return t.toLowerCase().includes(q); }));
      }).slice(0, 20);
    }

    if (matched.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results found.</div>';
      return;
    }

    var html = '';
    matched.forEach(function(item) {
      html += '<a href="' + item.url + '" class="search-result-item">' +
        '<div class="search-result-title">' + item.title + '</div>' +
        '<div class="search-result-meta">' + item.collection + ' &middot; ' + item.date + '</div>' +
        '</a>';
    });
    resultsEl.innerHTML = html;
  }

  // --- TOC Toggle (collapse/expand) ---
  function initTocToggle() {
    var toggle = document.getElementById('tocToggle');
    var body = document.getElementById('tocBody');
    var wrapper = document.getElementById('tocWrapper');

    if (!toggle || !body) return;

    toggle.addEventListener('click', function() {
      body.classList.toggle('collapsed');
      wrapper.classList.toggle('collapsed');
      var icon = toggle.querySelector('i');
      if (icon) {
        icon.className = body.classList.contains('collapsed')
          ? 'fa-solid fa-chevron-down'
          : 'fa-solid fa-chevron-up';
      }
    });

    // Generate TOC from headings
    generateTOC();
  }

  function generateTOC() {
    var content = document.getElementById('articleContent') || document.getElementById('docContent');
    var tocBody = document.getElementById('tocBody');
    if (!content || !tocBody) return;

    var headings = content.querySelectorAll('h2, h3');
    if (headings.length === 0) {
      var wrapper = document.getElementById('tocWrapper');
      if (wrapper) wrapper.style.display = 'none';
      return;
    }

    var html = '<ul>';
    headings.forEach(function(h) {
      var tag = h.tagName.toLowerCase();
      var id = h.id || h.textContent.toLowerCase().replace(/[^\w]+/g, '-');
      h.id = id;
      html += '<li class="' + tag + '_nav"><a href="#' + id + '">' + h.textContent + '</a></li>';
    });
    html += '</ul>';
    tocBody.innerHTML = html;
  }

  // --- Doc Sidebar Toggle (mobile) ---
  function initDocSidebar() {
    var toggle = document.getElementById('docSidebarToggle');
    var nav = document.querySelector('.doc-sidebar-nav');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', function() {
      nav.classList.toggle('open');
    });
  }

  // --- Code Copy Buttons ---
  function initCodeCopy() {
    // Only target the outermost pre that directly contains a <code> element.
    // This avoids duplicating buttons on Rouge line-number pre elements.
    document.querySelectorAll('.article-content pre > code, .doc-content pre > code').forEach(function(code) {
      var pre = code.parentElement;
      // Skip if already has a copy button or is a line-number block
      if (pre.classList.contains('lineno') || pre.querySelector('.code-copy-btn')) return;

      var btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = 'Copy';
      pre.style.position = 'relative';
      pre.appendChild(btn);

      btn.addEventListener('click', function() {
        var text = code.textContent;

        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function() {
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
          });
        } else {
          // Fallback
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        }
      });
    });
  }

  // --- Smooth Scroll for TOC anchors ---
  function initSmoothScroll() {
    document.addEventListener('click', function(e) {
      var target = e.target.closest('a[href^="#"]');
      if (!target) return;
      var href = target.getAttribute('href');
      if (href === '#') return;
      var el = document.querySelector(href);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  // --- Blog Category Filtering ---
  function initBlogFilter() {
    var chips = document.querySelectorAll('.chip');
    var posts = document.querySelectorAll('.post-card');
    var searchInput = document.getElementById('blogSearch');

    if (chips.length === 0 || posts.length === 0) return;

    chips.forEach(function(chip) {
      chip.addEventListener('click', function() {
        chips.forEach(function(c) { c.classList.remove('active'); });
        this.classList.add('active');
        filterPosts(this.dataset.filter, searchInput ? searchInput.value : '');
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', function() {
        var activeChip = document.querySelector('.chip.active');
        filterPosts(activeChip ? activeChip.dataset.filter : 'all', this.value);
      });
    }

    function filterPosts(category, query) {
      posts.forEach(function(post) {
        var catMatch = category === 'all' || post.dataset.category === category;
        var textMatch = !query || post.textContent.toLowerCase().includes(query.toLowerCase());
        post.style.display = catMatch && textMatch ? '' : 'none';
      });
    }
  }

})();
