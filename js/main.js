/* =============================================================
   main.js — Custom JavaScript for Moin Uddin Ahmed Portfolio 2026
   ============================================================= */

document.addEventListener('DOMContentLoaded', function () {

  // ---------------------------------------------------------
  // 1. Loading Screen
  // ---------------------------------------------------------
  const loader = document.getElementById('loader-wrapper-2026');
  if (loader) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        loader.classList.add('hidden');
      }, 400);
    });
    // Fallback: hide after 3s even if window.load hasn't fired
    setTimeout(function () {
      loader.classList.add('hidden');
    }, 3000);
  }

  // ---------------------------------------------------------
  // 2. Sticky Navbar — toggle .scrolled class
  // ---------------------------------------------------------
  const navbar = document.querySelector('.navbar-custom-2026');
  const navLinks = document.querySelector('.nav-links');
  const hamburger = document.querySelector('.nav-hamburger');

  function handleNavScroll() {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', handleNavScroll);

  // ---------------------------------------------------------
  // 3. Mobile Hamburger Toggle
  // ---------------------------------------------------------
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      hamburger.classList.toggle('active');
      navLinks.classList.toggle('open');
      document.body.classList.toggle('nav-open');
    });

    // Close mobile menu on link click
    navLinks.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        hamburger.classList.remove('active');
        navLinks.classList.remove('open');
        document.body.classList.remove('nav-open');
      });
    });
  }

  // ---------------------------------------------------------
  // 4. Initialize AOS (Animate on Scroll)
  // ---------------------------------------------------------
  if (typeof AOS !== 'undefined') {
    AOS.init({
      duration: 800,
      easing: 'ease-out',
      once: true,
      offset: 80,
      delay: 100,
    });
  }

  // ---------------------------------------------------------
  // 5. tsParticles — Hero Background
  // ---------------------------------------------------------
  if (typeof tsParticles !== 'undefined') {
    tsParticles.load('tsparticles', {
      fpsLimit: 60,
      particles: {
        number: { value: 60, density: { enable: true } },
        color: { value: '#00D9FF' },
        links: {
          enable: true,
          color: '#00D9FF',
          opacity: 0.2,
          distance: 150,
        },
        move: {
          enable: true,
          speed: 1,
          direction: 'none',
          random: false,
          straight: false,
          outModes: { default: 'bounce' },
        },
        opacity: {
          value: 0.3,
          random: true,
        },
        size: {
          value: 2,
          random: true,
        },
      },
      interactivity: {
        events: {
          onHover: { enable: true, mode: 'repulse' },
          onClick: { enable: true, mode: 'push' },
        },
        modes: {
          repulse: { distance: 100, duration: 0.4 },
          push: { quantity: 4 },
        },
      },
      background: { color: 'transparent' },
    });
  }

  // ---------------------------------------------------------
  // 6. Typed.js — Typewriter Effect
  // ---------------------------------------------------------
  if (typeof Typed !== 'undefined') {
    new Typed('#typed-text', {
      strings: [
        'Operations Engineer',
        'DevOps Architect',
        'Platform Reliability Engineer',
        'Security Researcher',
        'BRAC University CSE \'23',
      ],
      typeSpeed: 60,
      backSpeed: 30,
      loop: true,
      backDelay: 2000,
      startDelay: 500,
      showCursor: true,
      cursorChar: '|',
    });
  }

  // ---------------------------------------------------------
  // 7. Animated Stat Counters (GSAP + manual count-up)
  // ---------------------------------------------------------
  function animateCounters() {
    const counters = document.querySelectorAll('.stat-number');
    if (!counters.length) return;

    counters.forEach(function (el) {
      var raw = el.getAttribute('data-count');
      if (!raw) return;
      var isFloat = raw.indexOf('.') !== -1;
      var target = isFloat ? parseFloat(raw) : parseInt(raw, 10);
      var decimals = isFloat ? 2 : 0;
      var suffix = el.getAttribute('data-suffix') || '';
      var duration = 2000; // ms
      var startTime = null;

      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        var progress = Math.min((timestamp - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        var current = isFloat
          ? (eased * target).toFixed(decimals)
          : Math.floor(eased * target);
        el.textContent = current + suffix;
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          el.textContent = raw + suffix;
        }
      }

      requestAnimationFrame(step);
    });
  }

  // Trigger stat counters when #about comes into view
  var aboutSection = document.getElementById('about');
  if (aboutSection && typeof IntersectionObserver !== 'undefined') {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCounters();
            observer.disconnect();
          }
        });
      },
      { threshold: 0.3 }
    );
    observer.observe(aboutSection);
  } else if (aboutSection) {
    // Fallback: animate immediately
    animateCounters();
  }

  // ---------------------------------------------------------
  // 8. Skill Bar Fill Animation (GSAP or manual)
  // ---------------------------------------------------------
  function animateSkillBars() {
    var bars = document.querySelectorAll('.skill-bar-fill');
    if (!bars.length) return;

    bars.forEach(function (bar) {
      var target = bar.getAttribute('data-width');
      if (target) {
        bar.style.width = target + '%';
      }
    });
  }

  // Trigger when #skills comes into view
  var skillsSection = document.getElementById('skills');
  if (skillsSection && typeof IntersectionObserver !== 'undefined') {
    var skillsObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateSkillBars();
            skillsObserver.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );
    skillsObserver.observe(skillsSection);
  } else if (skillsSection) {
    animateSkillBars();
  }

  // ---------------------------------------------------------
  // 9. Education GPA Arc Animation
  // ---------------------------------------------------------
  function animateArcs() {
    var arcs = document.querySelectorAll('.edu-arc-fill');
    if (!arcs.length) return;

    arcs.forEach(function (arc) {
      var offset = arc.getAttribute('data-offset');
      if (offset) {
        arc.style.strokeDashoffset = offset;
      }
    });
  }

  var eduSection = document.getElementById('education');
  if (eduSection && typeof IntersectionObserver !== 'undefined') {
    var eduObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateArcs();
            eduObserver.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );
    eduObserver.observe(eduSection);
  } else if (eduSection) {
    animateArcs();
  }

  // ---------------------------------------------------------
  // 10. Timeline Expand/Collapse
  // ---------------------------------------------------------
  var timelineCards = document.querySelectorAll('.timeline-card');
  timelineCards.forEach(function (card) {
    card.addEventListener('click', function () {
      this.classList.toggle('active');
    });
  });

  // ---------------------------------------------------------
  // 11. Smooth Scroll for anchor links (fallback)
  // ---------------------------------------------------------
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ---------------------------------------------------------
  // 12. GSAP ScrollTrigger — register plugin if available
  // ---------------------------------------------------------
  if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
    gsap.registerPlugin(ScrollTrigger);
  }

  // ---------------------------------------------------------
  // 13. Console Easter Egg (moved here for cleanliness)
  // ---------------------------------------------------------
  // 14. Tech Marquee — duplicate content for seamless loop
  // ---------------------------------------------------------
  var techTrack = document.querySelector('.tech-track');
  if (techTrack) {
    var clone = techTrack.cloneNode(true);
    techTrack.parentNode.appendChild(clone);
  }

  // ---------------------------------------------------------
  // 15. Console Easter Egg
  // ---------------------------------------------------------
  console.log(
    '%c👋 Hey there, fellow developer!',
    'font-size: 18px; font-weight: bold; color: #00D9FF;'
  );
  console.log(
    '%cThanks for checking out the source. Feel free to reach out!',
    'font-size: 14px; color: #94A3B8;'
  );
  console.log(
    '%c- Moin Uddin Ahmed',
    'font-size: 14px; font-style: italic; color: #39FF14;'
  );

});
