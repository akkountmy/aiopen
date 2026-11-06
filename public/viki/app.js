(function(){
  var header = document.getElementById('header');
  var hero = document.querySelector('.hero');
  var mob = document.getElementById('mobCta');
  var cta = document.querySelector('.cta');
  var media = document.querySelector('.hero__media img');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ticking = false;

  function onScroll(){
    var y = window.scrollY || window.pageYOffset;
    header.classList.toggle('is-solid', y > 36);
    if (mob){
      var heroBottom = hero ? hero.offsetTop + hero.offsetHeight - 120 : 400;
      var ctaTop = cta ? cta.offsetTop - window.innerHeight + 120 : Infinity;
      mob.classList.toggle('in', y > heroBottom && y < ctaTop);
    }
    if (media && !reduce && window.innerWidth > 980){
      var shift = Math.min(y * 0.12, 90);
      media.style.transform = 'translate3d(0,' + shift + 'px,0) scale(1.04)';
    }
    ticking = false;
  }
  window.addEventListener('scroll', function(){
    if (!ticking){ ticking = true; window.requestAnimationFrame(onScroll); }
  }, {passive:true});
  onScroll();

  if ('IntersectionObserver' in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, {rootMargin:'0px 0px -8% 0px', threshold:0.12});
    document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function(el){ el.classList.add('in'); });
  }

  var links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var sections = links.map(function(a){ return document.querySelector(a.getAttribute('href')); }).filter(Boolean);
  if ('IntersectionObserver' in window && sections.length){
    var spy = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (!e.isIntersecting) return;
        links.forEach(function(a){ a.classList.toggle('is-active', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, {rootMargin:'-45% 0px -50% 0px'});
    sections.forEach(function(s){ spy.observe(s); });
  }
})();
