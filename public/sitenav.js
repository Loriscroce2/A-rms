// ===================================================================
// sitenav.js — Construit la barre de navigation partagée. Injectée dans
// n'importe quelle page qui contient un élément #site-header-root.
// Le bloc de droite (#nav-menu) reste géré par auth.js (pièces, avatar,
// bouton Se connecter/Créer un compte selon l'état de connexion).
// ===================================================================
(function(){
  const root = document.getElementById('site-header-root');
  if (!root) return;

  const links = [
    { href: '/accueil.html',  label: 'Accueil',  match: ['/accueil.html', '/', '/index.html'] },
    { href: '/play.html',     label: 'Jouer',     match: ['/play.html'] },
    { href: '/boutique.html', label: 'Boutique',  match: ['/boutique.html'] },
    { href: '/regles.html',   label: 'Règles',    match: ['/regles.html'] },
  ];
  const path = window.location.pathname;

  root.innerHTML = `
    <header class="siteHeader">
      <div class="navRow">
        <a class="brand" href="/accueil.html" aria-label="Accueil A'rms">
          <img src="/assets/logo-arms.png" alt="A'rms" />
        </a>
        <button class="navToggle" id="navToggleBtn" aria-label="Ouvrir le menu">☰</button>
        <nav class="siteNav" id="siteNavLinks">
          ${links.map(l => `<a href="${l.href}"${l.match.includes(path) ? ' class="active"' : ''}>${l.label}</a>`).join('')}
        </nav>
        <div class="navRight" id="nav-menu"></div>
      </div>
    </header>
  `;

  const toggle = document.getElementById('navToggleBtn');
  const nav = document.getElementById('siteNavLinks');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }
})();
