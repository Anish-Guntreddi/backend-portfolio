(() => {
  'use strict';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── scroll reveals ─────────────────────────────────────────── */
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  /* ── animated count-up ──────────────────────────────────────── */
  const counters = document.querySelectorAll('.count');
  const runCount = (el) => {
    const target = Number(el.dataset.to) || 0;
    if (reduceMotion) { el.textContent = String(target); return; }
    const duration = 1200;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = String(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = String(target);
    };
    requestAnimationFrame(tick);
  };
  if ('IntersectionObserver' in window) {
    const co = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { runCount(entry.target); co.unobserve(entry.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach((el) => co.observe(el));
  } else {
    counters.forEach(runCount);
  }

  /* ── activate diagram animations when in view ───────────────── */
  const diagrams = document.querySelectorAll('.diagram');
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const dobs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle('anim', entry.isIntersecting);
      });
    }, { threshold: 0.3 });
    diagrams.forEach((d) => dobs.observe(d));
  }

  /* ── hero terminal typewriter ───────────────────────────────── */
  const body = document.getElementById('terminal-body');
  const script = [
    { cls: 't-comment', text: '# three services, one spine — boot them all' },
    { prompt: true, text: 'docker compose up -d --build' },
    { cls: 't-ok', text: '✓ audittrail  :8080   ✓ flagforge  :8081   ✓ notifycore  :8082' },
    { spacer: true },
    { prompt: true, text: 'curl :8081/evaluate -d \'{"flagKey":"checkout","context":{"key":"u-42"}}\'' },
    { cls: 't-out', text: '→ { "value": true, "variation": "on",' },
    { cls: 't-out', text: '    "reason": { "kind": "FALLTHROUGH", "inRollout": true } }' },
    { spacer: true },
    { prompt: true, text: 'npm test --workspaces' },
    { cls: 't-ok', text: '✓ 161 passed  ·  0 failing  ·  tsc clean  ·  all gates green' },
  ];

  const writeLine = (line) => {
    const div = document.createElement('div');
    div.className = 'ln';
    if (line.spacer) { div.textContent = ' '; return div; }
    if (line.prompt) {
      const p = document.createElement('span'); p.className = 't-prompt'; p.textContent = '$ ';
      const c = document.createElement('span'); c.className = 't-cmd'; c.textContent = line.text;
      div.append(p, c);
    } else {
      const s = document.createElement('span'); s.className = line.cls || 't-out'; s.textContent = line.text;
      div.append(s);
    }
    return div;
  };

  const cursor = document.createElement('span');
  cursor.className = 't-cursor';

  if (!body) { /* no-op */ }
  else if (reduceMotion) {
    script.forEach((line) => body.appendChild(writeLine(line)));
  } else {
    let i = 0;
    body.appendChild(cursor);
    const typeNext = () => {
      if (i >= script.length) { return; }
      const line = script[i];
      // Lines that are output/comments appear instantly; command lines "type".
      const node = writeLine(line);
      if (line.prompt) {
        // type the command text character by character
        const cmdSpan = node.querySelector('.t-cmd');
        const full = line.text;
        cmdSpan.textContent = '';
        body.insertBefore(node, cursor);
        let j = 0;
        const typeChar = () => {
          cmdSpan.textContent = full.slice(0, j);
          j++;
          if (j <= full.length) { setTimeout(typeChar, 14 + Math.random() * 26); }
          else { i++; setTimeout(typeNext, 240); }
        };
        typeChar();
      } else {
        body.insertBefore(node, cursor);
        i++;
        setTimeout(typeNext, line.spacer ? 90 : 360);
      }
    };
    setTimeout(typeNext, 650);
  }
})();
