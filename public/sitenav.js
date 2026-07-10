// ===================================================================
// sitenav.js — Construit la barre de navigation partagée. Injectée dans
// n'importe quelle page qui contient un élément #site-header-root.
// Le menu s'adapte à l'état de connexion : non connecté, seuls "Accueil" et
// "Règles" sont visibles (le reste — Jouer, Classement, Didacticiel —
// nécessite un compte) ; "Boutique" n'apparaît JAMAIS ici, elle est gérée à
// part par auth.js (bouton doré à droite, uniquement une fois connecté), pour
// ne jamais l'afficher deux fois.
// Le bloc de droite (#nav-menu) reste géré par auth.js (pièces, avatar,
// bouton Se connecter/Créer un compte selon l'état de connexion).
// ===================================================================
(async function(){
  const root = document.getElementById('site-header-root');
  if (!root) return;

  let isLoggedIn = false;
  let isAdmin = false;
  try{
    const res = await fetch('/api/me');
    const data = await res.json();
    isLoggedIn = !!(res.ok && data.user);
    isAdmin = !!(isLoggedIn && data.user.isAdmin);
  }catch(e){}

  const fullLinks = [
    { href: '/accueil.html',  label: 'Accueil',  match: ['/accueil.html', '/', '/index.html'] },
    { href: '/play.html',     label: 'Jouer',     match: ['/play.html'] },
    { href: '/classement.html', label: 'Classement', match: ['/classement.html'] },
    { href: '/regles.html',   label: 'Règles',    match: ['/regles.html'] },
    { href: '/tutorial.html', label: 'Didacticiel', match: ['/tutorial.html'] },
  ];
  if (isAdmin) {
    fullLinks.push({ href: '/admin.html', label: '⚙ Administrateur', match: ['/admin.html'] });
  }
  const loggedOutLinks = [
    { href: '/accueil.html',  label: 'Accueil',  match: ['/accueil.html', '/', '/index.html'] },
    { href: '/regles.html',   label: 'Règles',    match: ['/regles.html'] },
  ];
  const links = isLoggedIn ? fullLinks : loggedOutLinks;
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
