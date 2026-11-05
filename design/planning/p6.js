// Mockup-only: theme toggle. ?theme=dark|light, remembered in localStorage.
(function () {
  var q = new URLSearchParams(location.search).get('theme');
  var t = q || localStorage.getItem('p6-theme') || 'light';
  document.documentElement.setAttribute('data-theme', t);
  function set(n) {
    document.documentElement.setAttribute('data-theme', n);
    localStorage.setItem('p6-theme', n);
    render();
  }
  function render() {
    var cur = document.documentElement.getAttribute('data-theme');
    var box = document.querySelector('.mk-toggle');
    if (!box) return;
    box.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.t === cur));
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.createElement('div');
    box.className = 'mk-toggle';
    box.innerHTML = 'theme <button data-t="light">light</button><button data-t="dark">dark</button>';
    box.addEventListener('click', function (e) {
      if (e.target.dataset.t) set(e.target.dataset.t);
    });
    document.body.appendChild(box);
    render();
    document.querySelectorAll('.pl-grp-title').forEach(function (h) {
      h.addEventListener('click', function (e) {
        if (h.dataset.toggle !== undefined) {
          e.preventDefault();
          h.closest('.pl-group').classList.toggle('collapsed');
        }
      });
    });
  });
})();
