/* Loaded before the application so an idle API response cannot reach its fallbacks. */
(() => {
  'use strict';
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;

  let idle = false;
  const waiting = new Promise(() => {});

  function isLocalApi(input) {
    try {
      const value = input && typeof input.url === 'string' ? input.url : input;
      const url = new URL(value, window.location.href);
      return url.origin === window.location.origin &&
        (url.pathname === '/api' || url.pathname.startsWith('/api/'));
    } catch (_) {
      // Leave invalid fetch inputs to the native implementation.
      return false;
    }
  }

  window.fetch = function (...args) {
    if (!isLocalApi(args[0])) return nativeFetch.apply(this, args);
    if (idle) return waiting;
    return nativeFetch.apply(this, args).then(response => {
      if (response.headers.get('X-AxiX-Action') === 'idle') idle = true;
      return idle ? waiting : response;
    }, error => {
      if (idle) return waiting;
      throw error;
    });
  };

  function stopInteraction(event) {
    if (!idle) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  [
    'click', 'dblclick', 'auxclick', 'contextmenu',
    'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove',
    'touchstart', 'touchend', 'touchmove', 'touchcancel',
    'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change',
    'submit', 'reset', 'dragstart', 'dragover', 'drop', 'wheel'
  ].forEach(type => window.addEventListener(type, stopInteraction, {
    capture: true,
    passive: false
  }));

  // A request already in progress may have its own timer. Only this marked page
  // suppresses its native dialogs; ordinary users retain their normal dialogs.
  [['alert', undefined], ['confirm', false], ['prompt', null]].forEach(([name, result]) => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function (...args) {
      if (idle) return result;
      return original.apply(window, args);
    };
  });
})();
