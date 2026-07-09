// ===================================================================
// auth.js — Statut de connexion + système de compte complet
// (avatar, menu déroulant façon "gros jeu de cartes", réglages)
// Chargé sur chaque page ayant un élément #nav-menu.
// ===================================================================

// Renvoie l'URL d'image à utiliser pour un avatar. Si aucun avatar n'a été
// choisi, on utilise l'image "?" stylée par défaut (assets/avatarbase.png).
function armsAvatarUrl(avatar) {
  if (!avatar) return '/assets/avatarbase.png';
  return avatar.startsWith('data:') ? avatar : `/cartes/${avatar}.png`;
}

function armsApplyAvatar(el, avatar) {
  el.style.backgroundImage = `url('${armsAvatarUrl(avatar)}')`;
  el.textContent = '';
}

// Chemin du logo officiel (fourni par l'utilisateur) pour un rang donné.
// Convention "rank-{palier}-{niveau}.png" — nouveaux noms de fichiers,
// garantis sans collision avec d'anciens caches de navigateur/CDN.
function armsRankImageUrl(rank){
  if (!rank) return '';
  const slug = rank.tierName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return `/assets/rank-${slug}-${rank.subLevel}.png`;
}

// Couleurs associées à chaque palier de Menace (du plus calme au plus terrifiant).
function armsRankTierColor(tierName) {
  switch (tierName) {
    case 'Mineure':       return { c1:'#3ddc84', c2:'#1b7a45', glow:'rgba(61,220,132,.5)',  text:'#c8ffe0' };
    case 'Hostile':       return { c1:'#ffd93d', c2:'#c98a00', glow:'rgba(255,217,61,.5)',  text:'#fff3c9' };
    case 'Mortelle':      return { c1:'#ff5c5c', c2:'#8a0000', glow:'rgba(255,60,60,.55)',  text:'#ffd6d6' };
    case 'Apocalyptique': return { c1:'#c86bff', c2:'#5a0d8a', glow:'rgba(180,60,255,.6)',  text:'#f0d6ff' };
    case 'Extinction':    return { c1:'#ff3b3b', c2:'#120004', glow:'rgba(255,20,20,.9)',   text:'#ffdede' };
    default:              return { c1:'#7df9ff', c2:'#0a4f5c', glow:'rgba(125,249,255,.4)', text:'#e8fdff' };
  }
}
function armsRankBadgeHtml(rank, opts) {
  opts = opts || {};
  if (!rank) return '';
  const colors = armsRankTierColor(rank.tierName);
  const pad = opts.large ? '10px 34px 10px 10px' : (opts.small ? '5px 20px 5px 5px' : '7px 26px 7px 7px');
  const fs = opts.large ? '24px' : (opts.small ? '15px' : '18px');
  const imgSize = opts.large ? '116px' : (opts.small ? '60px' : '84px');
  const imgUrl = armsRankImageUrl(rank);
  return `<span class="rankPill" style="padding:${pad};font-size:${fs};background:linear-gradient(180deg,${colors.c1}30,${colors.c2}70);border:1.5px solid ${colors.c1};color:${colors.text};box-shadow:0 0 12px ${colors.glow}, inset 0 1px 0 rgba(255,255,255,.12);"><img src="${imgUrl}" alt="" style="width:${imgSize};height:${imgSize};border-radius:50%;object-fit:cover;flex:none;" onerror="this.style.display='none'">${rank.label}</span>`;
}

function armsInjectAccountStyles() {
  if (document.getElementById('armsAccountStyles')) return;
  const style = document.createElement('style');
  style.id = 'armsAccountStyles';
  style.textContent = `
    .coinsPill{display:inline-flex;align-items:center;gap:6px;}
    .rankPill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;font-weight:900;font-family:'Manrope',sans-serif;letter-spacing:.02em;white-space:nowrap;}
    .accountBtn{display:inline-flex;align-items:center;gap:10px;padding:5px 14px 5px 5px;border-radius:999px;
      background:linear-gradient(180deg,#0e2e39,#0a222a);border:1.5px solid rgba(125,249,255,.35);cursor:pointer;
      color:#e8fdff;font-weight:800;font-size:14px;transition:border-color .15s ease, transform .15s ease;}
    .accountBtn:hover{border-color:rgba(125,249,255,.7);transform:translateY(-1px);}
    .accountAvatarSm{width:52px;height:52px;border-radius:50%;background-size:cover;background-position:center;
      border:2px solid rgba(125,249,255,.6);box-shadow:0 0 10px rgba(0,230,255,.35);flex:none;
      display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-weight:800;font-size:20px;color:#7df9ff;background-color:#0a222a;}

    .armsModalOverlay{position:fixed;inset:0;z-index:8000;display:none;align-items:center;justify-content:center;
      background:rgba(2,8,11,.75);backdrop-filter:blur(5px);padding:20px;}
    .armsModalOverlay.show{display:flex;}
    .armsModal{width:min(520px,94vw);max-height:88vh;overflow:auto;border-radius:20px;border:1px solid rgba(125,249,255,.3);
      background:linear-gradient(160deg,#051821,#072d38);box-shadow:0 30px 70px rgba(0,0,0,.6), 0 0 40px rgba(0,230,255,.15);
      padding:28px;color:#e8fdff;position:relative;}
    .armsModalClose{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.25);
      background:rgba(255,255,255,.06);color:#fff;font-size:16px;cursor:pointer;}
    .armsModalClose:hover{background:rgba(255,255,255,.16);}

    .profileHead{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:18px;}
    .profileAvatarBig{width:104px;height:104px;border-radius:50%;background-size:cover;background-position:center;
      border:3px solid rgba(125,249,255,.6);box-shadow:0 0 24px rgba(0,230,255,.4);}
    .profileName{font-family:'Cinzel',serif;font-weight:800;font-size:20px;color:#dff;}
    .profileEmail{font-size:12.5px;color:#9fd6e6;opacity:.8;}
    .profileCoins{margin-top:4px;padding:6px 16px;border-radius:999px;background:linear-gradient(180deg,#4a3c0d,#2a2208);
      border:1.5px solid rgba(255,217,61,.6);color:#ffd93d;font-weight:900;font-size:15px;}

    .armsSectionTitle{font-family:'Cinzel',serif;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#7df9ff;
      opacity:.85;margin:18px 0 10px;border-bottom:1px solid rgba(125,249,255,.15);padding-bottom:6px;}
    .armsRowBtn{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border-radius:12px;
      background:rgba(255,255,255,.03);border:1px solid rgba(125,249,255,.15);margin-bottom:8px;cursor:pointer;transition:background .15s ease;}
    .armsRowBtn:hover{background:rgba(125,249,255,.08);}
    .armsRowBtn .lbl{font-weight:700;font-size:14px;}
    .armsRowBtn .val{font-size:12.5px;color:#9fd6e6;opacity:.85;}

    .toggleSwitch{position:relative;width:44px;height:24px;border-radius:999px;background:#1e3a42;border:1px solid rgba(125,249,255,.3);
      cursor:pointer;flex:none;transition:background .2s ease;}
    .toggleSwitch.on{background:#0aa860;}
    .toggleSwitch .knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;
      box-shadow:0 2px 4px rgba(0,0,0,.4);transition:transform .2s ease;}
    .toggleSwitch.on .knob{transform:translateX(20px);}

    .logoutBtnModal{width:100%;margin-top:16px;padding:11px;border-radius:12px;background:linear-gradient(180deg,#3a1414,#240808);
      border:1px solid rgba(255,90,90,.4);color:#ffb3b3;font-weight:800;cursor:pointer;font-size:14px;}
    .logoutBtnModal:hover{background:linear-gradient(180deg,#4a1a1a,#2e0a0a);}

    .backLink{display:inline-flex;align-items:center;gap:6px;color:#7df9ff;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:6px;}
  `;
  document.head.appendChild(style);
}

function armsBuildAccountModal(user) {
  armsInjectAccountStyles();
  let overlay = document.getElementById('armsAccountModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'armsAccountModal';
  overlay.className = 'armsModalOverlay';

  const reduceMotion = localStorage.getItem('arms_reduce_motion') === '1';

  function renderProfileView() {
    overlay.innerHTML = `
      <div class="armsModal">
        <button class="armsModalClose" id="armsModalCloseBtn">✕</button>
        <div class="profileHead">
          <div class="profileAvatarBig" id="profileAvatarBig"></div>
          <div class="profileName">${user.name}</div>
          <div class="profileEmail">${user.email}</div>
          <div class="profileCoins">🪙 ${user.coins ?? 0} pièces</div>
          ${user.rank ? `<div style="margin-top:8px;">${armsRankBadgeHtml(user.rank, { large:true })}</div>` : ''}
        </div>

        <div class="armsSectionTitle">Profil</div>
        <div class="armsRowBtn" id="goRankingBtn">
          <span class="lbl">🏆 Classement</span>
          <span class="val">Ouvrir →</span>
        </div>
        <div class="armsRowBtn" id="changeAvatarBtn">
          <span class="lbl">🖼️ Changer d'avatar</span>
          <span class="val">Modifier →</span>
        </div>
        <div class="armsRowBtn" id="goCollectionBtn">
          <span class="lbl">🗂️ Ma collection / decks</span>
          <span class="val">Ouvrir →</span>
        </div>
        <div class="armsRowBtn" id="goShopBtn">
          <span class="lbl">🏪 Boutique</span>
          <span class="val">Ouvrir →</span>
        </div>

        <div class="armsSectionTitle">Réglages</div>
        <div class="armsRowBtn" id="reduceMotionRow" style="cursor:default;">
          <span class="lbl">🎬 Réduire les animations</span>
          <div class="toggleSwitch ${reduceMotion ? 'on' : ''}" id="reduceMotionToggle"><div class="knob"></div></div>
        </div>

        <button class="logoutBtnModal" id="logoutBtnModal">Se déconnecter</button>
      </div>
    `;
    armsApplyAvatar(overlay.querySelector('#profileAvatarBig'), user.avatar);
    overlay.querySelector('#armsModalCloseBtn').addEventListener('click', closeModal);
    overlay.querySelector('#changeAvatarBtn').addEventListener('click', renderAvatarPicker);
    overlay.querySelector('#goRankingBtn').addEventListener('click', () => { window.location.href = '/classement.html'; });
    overlay.querySelector('#goCollectionBtn').addEventListener('click', () => { window.location.href = '/play.html'; });
    overlay.querySelector('#goShopBtn').addEventListener('click', () => { window.location.href = '/boutique.html'; });
    overlay.querySelector('#reduceMotionToggle').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      localStorage.setItem('arms_reduce_motion', on ? '1' : '0');
    });
    overlay.querySelector('#logoutBtnModal').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/accueil.html';
    });
  }

  function renderAvatarPicker() {
    overlay.innerHTML = `
      <div class="armsModal">
        <button class="armsModalClose" id="armsModalCloseBtn">✕</button>
        <div class="backLink" id="backToProfile">← Retour au profil</div>
        <div class="profileName" style="text-align:center;margin-bottom:14px;">Choisissez votre avatar</div>

        <div class="profileAvatarBig" id="avatarPreview" style="margin:0 auto 18px;"></div>

        <div class="armsRowBtn" id="uploadAvatarBtn" style="justify-content:center;gap:8px;">
          <span class="lbl">📤 Uploader ma propre image</span>
        </div>
        <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
      </div>
    `;
    armsApplyAvatar(overlay.querySelector('#avatarPreview'), user.avatar);
    overlay.querySelector('#armsModalCloseBtn').addEventListener('click', closeModal);
    overlay.querySelector('#backToProfile').addEventListener('click', renderProfileView);

    const fileInput = overlay.querySelector('#avatarFileInput');
    overlay.querySelector('#uploadAvatarBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await armsResizeImageToDataUrl(file, 256);
        const res = await fetch('/api/profile/avatar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl })
        });
        const data = await res.json();
        if (data.ok) {
          user.avatar = data.avatar;
          armsRefreshAvatarDisplays(data.avatar);
          renderProfileView();
        } else {
          alert("Impossible d'utiliser cette image (" + (data.error || 'erreur') + ").");
        }
      } catch (err) {
        console.error(err);
        alert("Erreur lors du traitement de l'image.");
      }
    });
  }

  function closeModal() { overlay.classList.remove('show'); }

  renderProfileView();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  return overlay;
}

function armsResizeImageToDataUrl(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
      else if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function armsRefreshAvatarDisplays(avatar) {
  document.querySelectorAll('.js-avatar-img').forEach(el => armsApplyAvatar(el, avatar));
}

document.addEventListener('DOMContentLoaded', async () => {
  const navMenu = document.getElementById('nav-menu');
  if (!navMenu) return; // Si la page n'a pas de menu de navigation, on ne fait rien.

  try {
    const response = await fetch('/api/me');
    const data = await response.json();

    if (response.ok && data.user) {
      // --- L'UTILISATEUR EST CONNECTÉ ---
      const user = data.user;
      navMenu.innerHTML = `
        <span class="coinsPill" id="coinsPill" title="Vos pièces">🪙 <strong id="coinsAmount">${user.coins ?? 0}</strong></span>
        ${user.rank ? `<a href="/classement.html" id="navRankPill" style="text-decoration:none;" title="Votre rang de Menace — cliquez pour voir le classement">${armsRankBadgeHtml(user.rank, { small:true })}</a>` : ''}
        <a class="btn shopBtn" id="shopNavBtn" href="/boutique.html">🏪 Boutique</a>
        <button class="accountBtn" id="accountMenuBtn">
          <span class="accountAvatarSm js-avatar-img" id="navAvatarImg"></span>
          <span>${user.name}</span>
        </button>
      `;
      armsApplyAvatar(document.getElementById('navAvatarImg'), user.avatar);
      const pill = document.getElementById('coinsPill');
      if (pill) pill.style.cssText = 'padding:9px 18px;border-radius:999px;border:1.5px solid rgba(255,217,61,.6);background:linear-gradient(180deg,#4a3c0d,#2a2208);color:#ffd93d;font-weight:900;font-size:17px;box-shadow:0 0 16px rgba(255,217,61,.3), inset 0 1px 0 rgba(255,255,255,.15);display:inline-flex;align-items:center;gap:6px;';
      const shopBtn = document.getElementById('shopNavBtn');
      if (shopBtn) shopBtn.style.cssText = 'background:linear-gradient(180deg,#ffe98a,#e0a800);color:#2a1c00;border:1px solid rgba(255,255,255,.5);box-shadow:0 0 14px rgba(255,217,61,.55), inset 0 0 10px rgba(255,255,255,.25);font-weight:900;';

      document.querySelectorAll('.js-coins-amount').forEach(el => { el.textContent = user.coins ?? 0; });

      const modal = armsBuildAccountModal(user);
      document.getElementById('accountMenuBtn').addEventListener('click', () => modal.classList.add('show'));

    } else {
      // --- L'UTILISATEUR N'EST PAS CONNECTÉ ---
      navMenu.innerHTML = `
        <a class="btn-secondary" href="/regles.html">Règles</a>
        <a class="btn-secondary" href="/login.html">Se connecter</a>
        <a class="btn-secondary" href="/register.html">Créer un compte</a>
      `;
    }
  } catch (error) {
    console.error("Erreur lors de la vérification de l'état de connexion :", error);
    navMenu.innerHTML = `
      <a class="btn-secondary" href="/regles.html">Règles</a>
      <a class="btn-secondary" href="/login.html">Se connecter</a>
      <a class="btn-secondary" href="/register.html">Créer un compte</a>
    `;
  }
});
