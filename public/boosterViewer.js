// ===================================================================
// boosterViewer.js — Visualiseur plein écran pour l'ouverture de boosters
// Utilisé à la fois pour les boosters de départ (play.html) et les
// boosters achetés en boutique (boutique.html).
//
// Usage : window.openBoosterViewer(codes, { isLucky, onClose })
// ===================================================================
(function () {
  let overlay, stage, counterEl, hintEl;
  let queue = [];
  let idx = 0;
  let onCloseCb = null;

  // Précharge les PV/PB de toutes les cartes une seule fois (utilisé pour les badges)
  const statsPromise = fetch('/data/card-stats.json', { cache: 'no-store' })
    .then(r => r.json()).catch(() => ({}));

  function injectStyles() {
    if (document.getElementById('bvStyles')) return;
    const style = document.createElement('style');
    style.id = 'bvStyles';
    style.textContent = `
      #boosterViewerOverlay{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;
        background:rgba(2,8,11,.93);backdrop-filter:blur(8px);}
      #boosterViewerOverlay.show{display:flex;animation:bvFadeIn .25s ease;}
      @keyframes bvFadeIn{from{opacity:0}to{opacity:1}}
      .bvClose{position:absolute;top:24px;right:28px;width:46px;height:46px;border-radius:50%;border:1px solid rgba(255,255,255,.3);
        background:rgba(255,255,255,.08);color:#fff;font-size:20px;cursor:pointer;z-index:20;transition:background .15s ease, transform .15s ease;}
      .bvClose:hover{background:rgba(255,255,255,.2);transform:scale(1.08);}
      .bvCounter{position:absolute;top:30px;left:50%;transform:translateX(-50%);color:#aefaff;font-weight:800;letter-spacing:.14em;font-size:13px;text-transform:uppercase;z-index:20;}
      .bvStage{position:relative;width:min(600px,84vw);height:min(840px,86vh);perspective:1300px;}
      .bvHint{position:absolute;bottom:36px;left:50%;transform:translateX(-50%);color:#bfefff;opacity:.75;font-size:13px;z-index:20;}
      .bvCard{position:absolute;inset:0;border-radius:18px;cursor:pointer;}
      .bvCard .inner{width:100%;height:100%;position:relative;transform-style:preserve-3d;transition:transform .6s cubic-bezier(.34,1.56,.64,1);}
      .bvCard.flip .inner{transform:rotateY(180deg);}
      .bvCard .face{position:absolute;inset:0;border-radius:18px;backface-visibility:hidden;background-size:contain;background-repeat:no-repeat;
        background-position:center;background-color:#04141a;border:3px solid rgba(125,249,255,.45);box-shadow:0 25px 55px rgba(0,0,0,.6);}
      .bvCard .back{background-image:url('/cartes/Versobasic.png');}
      .bvCard .front{transform:rotateY(180deg);}
      .bvCard.exiting{transition:transform .4s cubic-bezier(.4,0,1,1), opacity .4s ease;}
      .bvDone{color:#bfefff;font-weight:700;font-size:16px;text-align:center;}
      .bvLuckyVeil{position:fixed;inset:0;z-index:8950;pointer-events:none;background:rgba(2,8,11,0);transition:background .35s ease;}
      .bvLuckyVeil.active{background:rgba(2,8,11,.4);}
      .bvLuckyFlash{position:fixed;inset:0;z-index:8990;pointer-events:none;background:radial-gradient(circle at 50% 50%, rgba(255,233,138,.85), transparent 65%);
        opacity:0;animation:bvLuckyScreenFlash .8s ease-out forwards;}
      @keyframes bvLuckyScreenFlash{0%{opacity:0;}15%{opacity:1;}100%{opacity:0;}}
      .bvLuckyBanner{position:absolute;bottom:90px;left:50%;transform:translateX(-50%);max-width:min(560px,88vw);padding:14px 20px;border-radius:16px;
        text-align:center;font-weight:700;font-size:15px;background:linear-gradient(145deg,#3a2f0a,#1e1706);border:1px solid rgba(255,217,61,.55);
        color:#ffe98a;box-shadow:0 0 30px rgba(255,217,61,.3);z-index:20;animation:bvBannerIn .5s cubic-bezier(.2,.9,.3,1.3);}
      @keyframes bvBannerIn{from{opacity:0;transform:translate(-50%,10px) scale(.9);}to{opacity:1;transform:translate(-50%,0) scale(1);}}
      .bvConfetti{position:fixed;top:-16px;z-index:8980;pointer-events:none;border-radius:2px;}
      @keyframes bvConfettiFall{to{transform:translateY(105vh) rotate(var(--rot));opacity:.15;}}
      .bvStat{position:absolute;right:-18px;width:58px;height:58px;display:flex;align-items:center;justify-content:center;
        font-weight:900;font-size:24px;color:#fff;z-index:5;font-family:'Manrope',system-ui,sans-serif;}
      .bvHp{top:34%;border-radius:50%;background:radial-gradient(circle at 30% 24%, rgba(255,255,255,.75), transparent 42%), radial-gradient(closest-side, #ff5c5c 55%, #8a0000);border:3px solid rgba(255,190,190,.95);box-shadow:0 0 18px rgba(255,40,40,.65), 0 4px 8px rgba(0,0,0,.55), inset 0 -4px 8px rgba(0,0,0,.35), inset 0 2px 4px rgba(255,255,255,.4);text-shadow:0 1px 3px rgba(0,0,0,.9);}
      .bvShield{top:64%;border-radius:50% 50% 22% 22% / 64% 64% 30% 30%;background:radial-gradient(circle at 30% 22%, rgba(255,255,255,.75), transparent 42%), radial-gradient(closest-side, #55d6ff 55%, #0a4f8a);border:3px solid rgba(195,238,255,.95);box-shadow:0 0 18px rgba(70,195,255,.65), 0 4px 8px rgba(0,0,0,.55), inset 0 -4px 8px rgba(0,0,0,.3), inset 0 2px 4px rgba(255,255,255,.4);color:#eafcff;font-size:22px;text-shadow:0 1px 3px rgba(0,0,0,.9);}
    `;
    document.head.appendChild(style);
  }

  function ensureOverlay() {
    if (overlay) return;
    injectStyles();
    overlay = document.createElement('div');
    overlay.id = 'boosterViewerOverlay';
    overlay.innerHTML = `
      <button class="bvClose" id="bvClose" aria-label="Fermer">✕</button>
      <div class="bvCounter" id="bvCounter"></div>
      <div class="bvStage" id="bvStage"></div>
      <div class="bvHint" id="bvHint">Cliquez sur la carte pour continuer</div>
    `;
    document.body.appendChild(overlay);
    stage = overlay.querySelector('#bvStage');
    counterEl = overlay.querySelector('#bvCounter');
    hintEl = overlay.querySelector('#bvHint');
    overlay.querySelector('#bvClose').addEventListener('click', closeViewer);
  }

  function spawnConfetti(count) {
    const colors = ['#ffd93d', '#7df9ff', '#2dffa0', '#ff9d3d', '#b06bff'];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'bvConfetti';
      const size = 6 + Math.random() * 7;
      el.style.width = size + 'px';
      el.style.height = (size * 0.4) + 'px';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      el.style.animation = `bvConfettiFall ${1.6 + Math.random() * 1.6}s ease-in forwards`;
      el.style.animationDelay = (Math.random() * 0.35) + 's';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3400);
    }
  }

  function renderCurrent() {
    stage.innerHTML = '';
    counterEl.textContent = `Carte ${idx + 1} / ${queue.length}`;
    hintEl.textContent = 'Cliquez sur la carte pour continuer';
    const code = queue[idx];
    const card = document.createElement('div');
    card.className = 'bvCard';
    card.innerHTML = `
      <div class="inner">
        <div class="face back"></div>
        <div class="face front" style="background-image:url('/cartes/${code}.png')"></div>
      </div>`;
    stage.appendChild(card);
    setTimeout(() => card.classList.add('flip'), 120);
    card.addEventListener('click', () => advance(card));

    statsPromise.then(stats => {
      const st = stats[code];
      if (!st || st.type !== 'personnage') return;
      const front = card.querySelector('.front');
      const hp = document.createElement('div');
      hp.className = 'bvStat bvHp';
      hp.textContent = st.hp ?? 0;
      front.appendChild(hp);
      if (st.shield > 0) {
        const sh = document.createElement('div');
        sh.className = 'bvStat bvShield';
        sh.textContent = st.shield;
        front.appendChild(sh);
      }
    });
  }

  function advance(card) {
    if (!card.classList.contains('flip')) { card.classList.add('flip'); return; }
    card.classList.add('exiting');
    card.style.transform = 'translateX(-130%) rotate(-18deg)';
    card.style.opacity = '0';
    setTimeout(() => {
      idx++;
      if (idx >= queue.length) {
        counterEl.textContent = 'Terminé';
        hintEl.textContent = 'Fermez avec la croix pour continuer';
        stage.innerHTML = `<div class="bvDone">✓ Booster entièrement ouvert<br><span style="opacity:.7;font-weight:400">Cliquez sur la croix pour continuer</span></div>`;
      } else {
        renderCurrent();
      }
    }, 380);
  }

  function closeViewer() {
    const current = stage.querySelector('.bvCard');
    if (current) {
      current.classList.add('exiting');
      current.style.transform = 'translateY(-120%) rotate(12deg)';
      current.style.opacity = '0';
    }
    setTimeout(() => {
      overlay.classList.remove('show');
      stage.innerHTML = '';
      const cb = onCloseCb;
      onCloseCb = null;
      if (cb) cb();
    }, current ? 260 : 0);
  }

  window.openBoosterViewer = function (codes, opts = {}) {
    ensureOverlay();
    queue = codes.slice();
    idx = 0;
    onCloseCb = opts.onClose || null;
    overlay.classList.add('show');
    renderCurrent();

    if (opts.isLucky) {
      const veil = document.createElement('div');
      veil.className = 'bvLuckyVeil';
      document.body.appendChild(veil);
      requestAnimationFrame(() => veil.classList.add('active'));
      const flash = document.createElement('div');
      flash.className = 'bvLuckyFlash';
      document.body.appendChild(flash);
      setTimeout(() => { veil.remove(); flash.remove(); }, 900);

      setTimeout(() => {
        const banner = document.createElement('div');
        banner.className = 'bvLuckyBanner';
        banner.innerHTML = `🎉 <strong>COUP DE CHANCE !</strong> Ce booster contient <strong>${codes.length} cartes</strong> au lieu de 7 !`;
        overlay.appendChild(banner);
        spawnConfetti(90);
        setTimeout(() => banner.remove(), 4500);
      }, 500);
    }
  };
})();
