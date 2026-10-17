'use strict';
// Independent bootstrap: reports resource-load and runtime failures before the
// main renderer bundle reaches the unlock UI.
(function () {
  function report(kind, detail) {
    var text = kind + ': ' + detail;
    try { if (window.api && window.api.diagnostics) window.api.diagnostics.log(text); } catch (_) {}
    var box = document.getElementById('unlockBox');
    if (box) {
      box.textContent = '';
      var heading = document.createElement('h3'); heading.textContent = '起動エラー';
      var error = document.createElement('div'); error.className = 'error'; error.style.whiteSpace = 'pre-wrap'; error.textContent = text;
      box.append(heading, error);
    }
  }
  window.addEventListener('error', function (e) {
    var source = e.filename || (e.target && e.target.src) || 'resource';
    report('JavaScript', (e.message || '読み込みに失敗') + ' @ ' + source + (e.lineno ? ':' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    report('Promise', e.reason && (e.reason.stack || e.reason.message) || String(e.reason));
  });
  try { if (window.api && window.api.diagnostics) window.api.diagnostics.log('HTML bootstrap started'); } catch (_) {}
})();
