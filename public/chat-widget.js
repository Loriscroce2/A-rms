// ===================================================================
// chat-widget.js — Tchat global flottant (Général + Amis en privé)
// Chargé sur toutes les pages du site SAUF la partie 1v1 (index.html),
// login.html et register.html (utilisateur pas encore connecté).
// Dépend de auth.js (pour armsAvatarUrl) et du client socket.io
// (<script src="/socket.io/socket.io.js">), tous deux inclus avant ce
// fichier. Ne fait rien si l'utilisateur n'est pas connecté.
// ===================================================================

(function () {
  const CHAT_COLOR_PRESETS = ['#7df9ff', '#ffffff', '#ffd93d', '#ff8a5c', '#ff5c5c', '#c86bff', '#5cff8a', '#5c9dff'];

  const State = {
    user: null,
    socket: null,
    panelOpen: false,
    activeTab: 'general', // 'general' | 'friends'
    friendsSubview: 'list', // 'list' | 'thread'
    activeFriend: null, // { id, name, avatar }
    generalMessages: [],
    generalOldestId: null,
    generalHasMore: true,
    privateCache: {}, // friendId -> { messages: [], oldestId, hasMore }
    friendsData: { friends: [], incoming: [], outgoing: [] },
    searchMatches: [],
  };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
      return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function avatarUrl(avatar) {
    if (typeof armsAvatarUrl === 'function') return armsAvatarUrl(avatar);
    return avatar ? `/assets/Avatar/${encodeURIComponent(avatar)}` : '/assets/avatarbase.png';
  }

  // -------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('chatWidgetStyles')) return;
    const style = document.createElement('style');
    style.id = 'chatWidgetStyles';
    style.textContent = `
      #chatWidgetBtn{position:fixed;bottom:22px;right:22px;width:58px;height:58px;border-radius:50%;
        background:linear-gradient(160deg,#0e2e39,#0a222a);border:1.5px solid rgba(125,249,255,.45);
        box-shadow:0 8px 24px rgba(0,0,0,.5), 0 0 20px rgba(0,230,255,.2);cursor:pointer;z-index:9000;
        display:flex;align-items:center;justify-content:center;font-size:26px;transition:transform .15s ease;}
      #chatWidgetBtn:hover{transform:translateY(-2px) scale(1.05);}
      #chatWidgetBadge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;
        background:#ff5c5c;color:#fff;font-size:11px;font-weight:900;display:none;align-items:center;justify-content:center;
        border:2px solid #041016;font-family:'Manrope',sans-serif;}
      #chatWidgetBadge.show{display:flex;}
      #chatWidgetPanel{position:fixed;bottom:90px;right:22px;width:350px;max-width:92vw;height:500px;max-height:76vh;
        background:linear-gradient(160deg,#051821,#072d38);border:1px solid rgba(125,249,255,.3);border-radius:18px;
        box-shadow:0 30px 70px rgba(0,0,0,.6), 0 0 40px rgba(0,230,255,.12);z-index:9000;display:none;
        flex-direction:column;overflow:hidden;color:#e8fdff;font-family:'Manrope',sans-serif;}
      #chatWidgetPanel.show{display:flex;}
      .cwTabs{display:flex;border-bottom:1px solid rgba(125,249,255,.15);flex:none;}
      .cwTab{flex:1;padding:12px 8px;text-align:center;font-weight:800;font-size:13px;color:#9fd6e6;cursor:pointer;
        background:transparent;border:none;border-bottom:2px solid transparent;position:relative;}
      .cwTab.active{color:#7df9ff;border-bottom-color:#7df9ff;background:rgba(125,249,255,.06);}
      .cwTabBadge{position:absolute;top:6px;right:calc(50% - 34px);min-width:16px;height:16px;padding:0 4px;border-radius:999px;
        background:#ff5c5c;color:#fff;font-size:9.5px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;}
      .cwCloseBtn{flex:none;width:38px;background:transparent;border:none;color:#9fd6e6;font-size:16px;cursor:pointer;}
      .cwHeaderRow{display:flex;align-items:center;border-bottom:1px solid rgba(125,249,255,.15);flex:none;}
      .cwBackBtn{padding:10px 12px;background:transparent;border:none;color:#7df9ff;font-weight:800;font-size:13px;cursor:pointer;}
      .cwThreadWho{display:flex;align-items:center;gap:8px;flex:1;font-weight:800;font-size:13.5px;}
      .cwThreadAvatar{width:26px;height:26px;border-radius:50%;background-size:cover;background-position:center;flex:none;}
      .cwOnlineDot{width:8px;height:8px;border-radius:50%;background:#3ddc84;box-shadow:0 0 6px rgba(61,220,132,.8);flex:none;}
      .cwOnlineDot.off{background:#4a5a60;box-shadow:none;}
      .cwBody{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
      .cwLoadMore{align-self:center;font-size:11.5px;color:#7df9ff;cursor:pointer;padding:4px 10px;border-radius:999px;
        border:1px solid rgba(125,249,255,.3);background:rgba(125,249,255,.05);margin-bottom:4px;}
      .cwMsgRow{display:flex;gap:8px;align-items:flex-start;}
      .cwMsgAvatar{width:28px;height:28px;border-radius:50%;background-size:cover;background-position:center;flex:none;
        border:1.5px solid rgba(125,249,255,.3);}
      .cwMsgBody{flex:1;min-width:0;}
      .cwMsgHead{display:flex;align-items:baseline;gap:6px;margin-bottom:1px;}
      .cwMsgName{font-weight:800;font-size:12px;color:#9fd6e6;}
      .cwMsgTime{font-size:10px;color:#5f8a96;}
      .cwMsgText{font-size:13.5px;line-height:1.35;word-break:break-word;}
      .cwEmpty{text-align:center;color:#5f8a96;font-size:12.5px;padding:20px 10px;}
      .cwInputRow{display:flex;gap:6px;padding:10px;border-top:1px solid rgba(125,249,255,.15);flex:none;align-items:center;}
      .cwInputRow input[type=text]{flex:1;padding:9px 12px;border-radius:999px;border:1.5px solid rgba(125,249,255,.3);
        background:#051820;color:#e8fdff;font-size:13px;min-width:0;}
      .cwInputRow input[type=text]:focus{outline:none;border-color:rgba(125,249,255,.7);}
      .cwColorSwatch{width:30px;height:30px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;flex:none;
        padding:0;}
      .cwSendBtn{width:34px;height:34px;border-radius:50%;border:none;background:linear-gradient(160deg,#0e6b7a,#0a4f5c);
        color:#e8fdff;font-size:15px;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;}
      .cwSendBtn:hover{filter:brightness(1.15);}
      .cwColorPopover{position:absolute;bottom:58px;right:52px;background:#072d38;border:1px solid rgba(125,249,255,.3);
        border-radius:12px;padding:10px;display:none;grid-template-columns:repeat(4,1fr);gap:8px;box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:20;}
      .cwColorPopover.show{display:grid;}
      .cwColorChip{width:26px;height:26px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.15);}
      .cwColorChip.active{border-color:#fff;}
      .cwColorCustom{grid-column:1/-1;width:100%;height:28px;border:none;border-radius:8px;cursor:pointer;background:transparent;}
      .cwSection{margin-bottom:12px;}
      .cwSectionTitle{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7df9ff;opacity:.8;
        margin-bottom:6px;font-weight:800;}
      .cwAddRow{display:flex;gap:6px;margin-bottom:6px;}
      .cwAddRow input{flex:1;padding:8px 12px;border-radius:999px;border:1.5px solid rgba(125,249,255,.3);
        background:#051820;color:#e8fdff;font-size:12.5px;min-width:0;}
      .cwAddRow button{flex:none;padding:8px 14px;border-radius:999px;border:1.5px solid rgba(125,249,255,.4);
        background:rgba(125,249,255,.1);color:#7df9ff;font-weight:800;font-size:12px;cursor:pointer;}
      .cwAddRow button:hover{background:rgba(125,249,255,.2);}
      .cwFriendRow{display:flex;align-items:center;gap:9px;padding:8px;border-radius:12px;cursor:pointer;
        border:1px solid rgba(125,249,255,.1);margin-bottom:6px;background:rgba(255,255,255,.02);}
      .cwFriendRow:hover{background:rgba(125,249,255,.07);}
      .cwFriendAvatar{width:34px;height:34px;border-radius:50%;background-size:cover;background-position:center;flex:none;position:relative;}
      .cwFriendInfo{flex:1;min-width:0;}
      .cwFriendName{font-weight:800;font-size:13px;display:flex;align-items:center;gap:6px;}
      .cwFriendLast{font-size:11px;color:#8fb8c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .cwUnreadBadge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ff5c5c;color:#fff;
        font-size:10.5px;font-weight:900;display:flex;align-items:center;justify-content:center;flex:none;}
      .cwMiniBtn{flex:none;width:28px;height:28px;border-radius:50%;border:1px solid rgba(125,249,255,.3);
        background:rgba(125,249,255,.06);color:#e8fdff;font-size:13px;cursor:pointer;}
      .cwMiniBtn.accept{border-color:rgba(61,220,132,.5);color:#3ddc84;}
      .cwMiniBtn.decline{border-color:rgba(255,92,92,.5);color:#ff5c5c;}
    `;
    document.head.appendChild(style);
  }

  // -------------------------------------------------------------
  // Construction du DOM
  // -------------------------------------------------------------
  function buildDom() {
    const btn = document.createElement('button');
    btn.id = 'chatWidgetBtn';
    btn.innerHTML = `💬<span id="chatWidgetBadge"></span>`;
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'chatWidgetPanel';
    panel.innerHTML = `
      <div class="cwTabs">
        <button class="cwTab active" id="cwTabGeneral">💬 Général</button>
        <button class="cwTab" id="cwTabFriends">👥 Amis<span class="cwTabBadge" id="cwFriendsBadge" style="display:none;"></span></button>
        <button class="cwCloseBtn" id="cwCloseBtn">✕</button>
      </div>
      <div id="cwGeneralView" style="display:flex;flex-direction:column;flex:1;min-height:0;">
        <div class="cwBody" id="cwGeneralBody"></div>
        ${inputRowHtml('cwGeneral')}
      </div>
      <div id="cwFriendsListView" style="display:none;flex-direction:column;flex:1;min-height:0;">
        <div class="cwBody" id="cwFriendsBody"></div>
      </div>
      <div id="cwThreadView" style="display:none;flex-direction:column;flex:1;min-height:0;">
        <div class="cwHeaderRow">
          <button class="cwBackBtn" id="cwThreadBackBtn">← Retour</button>
          <div class="cwThreadWho" id="cwThreadWho"></div>
          <button class="cwMiniBtn decline" id="cwThreadRemoveBtn" title="Retirer cet ami" style="margin-right:10px;">🗑</button>
        </div>
        <div class="cwBody" id="cwThreadBody"></div>
        ${inputRowHtml('cwThread')}
      </div>
    `;
    document.body.appendChild(panel);

    function inputRowHtml(prefix) {
      return `
        <div class="cwInputRow" style="position:relative;">
          <button class="cwColorSwatch" id="${prefix}ColorBtn" title="Couleur de votre police"></button>
          <div class="cwColorPopover" id="${prefix}ColorPopover">
            ${CHAT_COLOR_PRESETS.map(c => `<div class="cwColorChip" data-color="${c}" style="background:${c};"></div>`).join('')}
            <input type="color" class="cwColorCustom" id="${prefix}ColorCustom" />
          </div>
          <input type="text" id="${prefix}Input" placeholder="Écrire un message…" maxlength="500" />
          <button class="cwSendBtn" id="${prefix}SendBtn">➤</button>
        </div>
      `;
    }

    return { btn, panel };
  }

  // -------------------------------------------------------------
  // Rendu des messages
  // -------------------------------------------------------------
  function renderMessageRow(m) {
    return `
      <div class="cwMsgRow">
        <div class="cwMsgAvatar" style="background-image:url('${avatarUrl(m.avatar)}')"></div>
        <div class="cwMsgBody">
          <div class="cwMsgHead"><span class="cwMsgName">${esc(m.name)}</span><span class="cwMsgTime">${fmtTime(m.createdAt)}</span></div>
          <div class="cwMsgText" style="color:${esc(m.color || '#e8fdff')};">${esc(m.text)}</div>
        </div>
      </div>
    `;
  }

  function renderGeneralBody() {
    const body = document.getElementById('cwGeneralBody');
    const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    body.innerHTML = (State.generalHasMore ? `<div class="cwLoadMore" id="cwGeneralLoadMore">Charger les messages précédents</div>` : '')
      + (State.generalMessages.length ? State.generalMessages.map(renderMessageRow).join('') : `<div class="cwEmpty">Aucun message pour l'instant — lancez la discussion !</div>`);
    const loadMoreBtn = document.getElementById('cwGeneralLoadMore');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadGeneralHistory(true));
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
  }

  function renderThreadBody() {
    if (!State.activeFriend) return;
    const cache = State.privateCache[State.activeFriend.id] || { messages: [], hasMore: false };
    const body = document.getElementById('cwThreadBody');
    const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    body.innerHTML = (cache.hasMore ? `<div class="cwLoadMore" id="cwThreadLoadMore">Charger les messages précédents</div>` : '')
      + (cache.messages.length ? cache.messages.map(renderMessageRow).join('') : `<div class="cwEmpty">Aucun message avec ${esc(State.activeFriend.name)} pour l'instant.</div>`);
    const loadMoreBtn = document.getElementById('cwThreadLoadMore');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadPrivateHistory(State.activeFriend.id, true));
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
  }

  function renderFriendsBody() {
    const body = document.getElementById('cwFriendsBody');
    const { friends, incoming, outgoing } = State.friendsData;
    let html = `
      <div class="cwSection">
        <div class="cwSectionTitle">Ajouter un ami</div>
        <div class="cwAddRow">
          <input type="text" id="cwSearchInput" placeholder="Pseudo exact du joueur…" maxlength="40" />
          <button id="cwSearchBtn">Ajouter</button>
        </div>
        <div id="cwSearchResults"></div>
      </div>
    `;
    if (incoming.length) {
      html += `<div class="cwSection"><div class="cwSectionTitle">Demandes reçues</div>` +
        incoming.map(r => `
          <div class="cwFriendRow" style="cursor:default;">
            <div class="cwFriendAvatar" style="background-image:url('${avatarUrl(r.avatar)}')"></div>
            <div class="cwFriendInfo"><div class="cwFriendName">${esc(r.name)}</div></div>
            <button class="cwMiniBtn accept" data-id="${r.friendshipId}" title="Accepter">✓</button>
            <button class="cwMiniBtn decline" data-id="${r.friendshipId}" title="Refuser">✕</button>
          </div>
        `).join('') + `</div>`;
    }
    if (outgoing.length) {
      html += `<div class="cwSection"><div class="cwSectionTitle">Demandes envoyées</div>` +
        outgoing.map(r => `
          <div class="cwFriendRow" style="cursor:default;">
            <div class="cwFriendAvatar" style="background-image:url('${avatarUrl(r.avatar)}')"></div>
            <div class="cwFriendInfo"><div class="cwFriendName">${esc(r.name)}</div><div class="cwFriendLast">En attente…</div></div>
            <button class="cwMiniBtn decline" data-cancel="${r.friendshipId}" title="Annuler">✕</button>
          </div>
        `).join('') + `</div>`;
    }
    html += `<div class="cwSection"><div class="cwSectionTitle">Mes amis${friends.length ? ` (${friends.length})` : ''}</div>`;
    if (friends.length) {
      html += friends.map(f => `
        <div class="cwFriendRow" data-friend-id="${f.id}" data-friend-name="${esc(f.name)}" data-friend-avatar="${esc(f.avatar)}">
          <div class="cwFriendAvatar" style="background-image:url('${avatarUrl(f.avatar)}')">
            <span class="cwOnlineDot ${f.online ? '' : 'off'}" style="position:absolute;bottom:-1px;right:-1px;"></span>
          </div>
          <div class="cwFriendInfo">
            <div class="cwFriendName">${esc(f.name)}</div>
            <div class="cwFriendLast">${f.lastMessage ? esc(f.lastMessage) : 'Aucun message'}</div>
          </div>
          ${f.unread ? `<div class="cwUnreadBadge">${f.unread}</div>` : ''}
        </div>
      `).join('');
    } else {
      html += `<div class="cwEmpty">Pas encore d'amis — ajoutez-en un par son pseudo ci-dessus !</div>`;
    }
    html += `</div>`;
    body.innerHTML = html;

    const searchInput = document.getElementById('cwSearchInput');
    document.getElementById('cwSearchBtn').addEventListener('click', () => doFriendSearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFriendSearch(searchInput.value); });

    body.querySelectorAll('.cwMiniBtn.accept').forEach(b => b.addEventListener('click', () => respondFriendRequest(parseInt(b.dataset.id, 10), true)));
    body.querySelectorAll('.cwMiniBtn.decline[data-id]').forEach(b => b.addEventListener('click', () => respondFriendRequest(parseInt(b.dataset.id, 10), false)));
    body.querySelectorAll('.cwMiniBtn.decline[data-cancel]').forEach(b => b.addEventListener('click', () => cancelFriendRequest(parseInt(b.dataset.cancel, 10))));
    body.querySelectorAll('.cwFriendRow[data-friend-id]').forEach(row => row.addEventListener('click', () => {
      openThread({ id: parseInt(row.dataset.friendId, 10), name: row.dataset.friendName, avatar: row.dataset.friendAvatar });
    }));
  }

  function updateBadges() {
    const unreadTotal = State.friendsData.friends.reduce((s, f) => s + (f.unread || 0), 0);
    const incomingCount = State.friendsData.incoming.length;
    const total = unreadTotal + incomingCount;
    const btnBadge = document.getElementById('chatWidgetBadge');
    if (total > 0) { btnBadge.textContent = total > 99 ? '99+' : String(total); btnBadge.classList.add('show'); }
    else { btnBadge.classList.remove('show'); }
    const tabBadge = document.getElementById('cwFriendsBadge');
    if (tabBadge) {
      if (total > 0) { tabBadge.textContent = total > 99 ? '99+' : String(total); tabBadge.style.display = 'inline-flex'; }
      else { tabBadge.style.display = 'none'; }
    }
  }

  // -------------------------------------------------------------
  // Réseau
  // -------------------------------------------------------------
  async function loadGeneralHistory(more) {
    try {
      const url = more && State.generalOldestId ? `/api/chat/general?before=${State.generalOldestId}` : '/api/chat/general';
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) return;
      if (data.messages.length < 50) State.generalHasMore = false;
      if (data.messages.length) State.generalOldestId = data.messages[0].id;
      State.generalMessages = more ? data.messages.concat(State.generalMessages) : data.messages;
      renderGeneralBody();
    } catch (e) { console.error(e); }
  }

  async function loadPrivateHistory(friendId, more) {
    try {
      const cache = State.privateCache[friendId] || { messages: [], oldestId: null, hasMore: true };
      const url = more && cache.oldestId ? `/api/chat/private/${friendId}?before=${cache.oldestId}` : `/api/chat/private/${friendId}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) return;
      if (data.messages.length < 50) cache.hasMore = false;
      if (data.messages.length) cache.oldestId = data.messages[0].id;
      cache.messages = more ? data.messages.concat(cache.messages) : data.messages;
      State.privateCache[friendId] = cache;
      renderThreadBody();
    } catch (e) { console.error(e); }
  }

  async function loadFriends() {
    try {
      const res = await fetch('/api/chat/friends');
      const data = await res.json();
      if (!data.ok) return;
      State.friendsData = data;
      updateBadges();
      if (State.activeTab === 'friends' && State.friendsSubview === 'list') renderFriendsBody();
    } catch (e) { console.error(e); }
  }

  async function doFriendSearch(pseudo) {
    pseudo = (pseudo || '').trim();
    const results = document.getElementById('cwSearchResults');
    if (!pseudo) return;
    try {
      const res = await fetch(`/api/chat/find-user?pseudo=${encodeURIComponent(pseudo)}`);
      const data = await res.json();
      if (!data.ok || !data.matches.length) {
        results.innerHTML = `<div class="cwEmpty">Aucun joueur avec ce pseudo exact.</div>`;
        return;
      }
      if (data.matches.length === 1) {
        sendFriendRequest(data.matches[0].id, results);
        return;
      }
      results.innerHTML = `<div class="cwEmpty" style="text-align:left;">Plusieurs joueurs ont ce pseudo, choisissez :</div>` +
        data.matches.map(m => `
          <div class="cwFriendRow" data-pick="${m.id}">
            <div class="cwFriendAvatar" style="background-image:url('${avatarUrl(m.avatar)}')"></div>
            <div class="cwFriendInfo"><div class="cwFriendName">${esc(m.name)}</div></div>
          </div>
        `).join('');
      results.querySelectorAll('[data-pick]').forEach(row => row.addEventListener('click', () => sendFriendRequest(parseInt(row.dataset.pick, 10), results)));
    } catch (e) { console.error(e); }
  }

  async function sendFriendRequest(targetId, resultsEl) {
    try {
      const res = await fetch('/api/chat/friends/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }),
      });
      const data = await res.json();
      if (data.ok) {
        resultsEl.innerHTML = `<div class="cwEmpty">${data.status === 'accepted' ? 'Ami ajouté !' : 'Demande envoyée !'}</div>`;
        loadFriends();
      } else {
        const msg = data.error === 'already_friends' ? 'Vous êtes déjà amis.'
          : data.error === 'request_already_sent' ? 'Demande déjà envoyée.'
          : "Impossible d'envoyer la demande.";
        resultsEl.innerHTML = `<div class="cwEmpty">${msg}</div>`;
      }
    } catch (e) { console.error(e); }
  }

  async function respondFriendRequest(friendshipId, accept) {
    try {
      await fetch('/api/chat/friends/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendshipId, accept }),
      });
      loadFriends();
    } catch (e) { console.error(e); }
  }

  async function cancelFriendRequest(friendshipId) {
    try {
      await fetch('/api/chat/friends/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendshipId }),
      });
      loadFriends();
    } catch (e) { console.error(e); }
  }

  function openThread(friend) {
    State.activeFriend = friend;
    State.friendsSubview = 'thread';
    document.getElementById('cwFriendsListView').style.display = 'none';
    document.getElementById('cwThreadView').style.display = 'flex';
    document.getElementById('cwThreadWho').innerHTML = `
      <div class="cwThreadAvatar" style="background-image:url('${avatarUrl(friend.avatar)}')"></div>
      <span>${esc(friend.name)}</span>
    `;
    if (!State.privateCache[friend.id]) {
      State.privateCache[friend.id] = { messages: [], oldestId: null, hasMore: true };
      loadPrivateHistory(friend.id, false);
    } else {
      renderThreadBody();
    }
    // Marque comme lu côté serveur + localement dès l'ouverture.
    fetch(`/api/chat/private/${friend.id}/read`, { method: 'POST' }).catch(() => {});
    const f = State.friendsData.friends.find(x => x.id === friend.id);
    if (f) { f.unread = 0; updateBadges(); }
  }

  function closeThread() {
    State.friendsSubview = 'list';
    State.activeFriend = null;
    document.getElementById('cwThreadView').style.display = 'none';
    document.getElementById('cwFriendsListView').style.display = 'flex';
    renderFriendsBody();
  }

  async function removeActiveFriend() {
    if (!State.activeFriend) return;
    if (!confirm(`Retirer ${State.activeFriend.name} de vos amis ? La conversation restera consultable si vous redevenez amis.`)) return;
    try {
      await fetch('/api/chat/friends/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendId: State.activeFriend.id }),
      });
      closeThread();
      loadFriends();
    } catch (e) { console.error(e); }
  }

  // -------------------------------------------------------------
  // Couleur de police
  // -------------------------------------------------------------
  async function saveChatColor(color) {
    State.user.chatColor = color;
    updateColorSwatches();
    try {
      await fetch('/api/profile/chat-color', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }),
      });
    } catch (e) { console.error(e); }
  }

  function updateColorSwatches() {
    ['cwGeneralColorBtn', 'cwThreadColorBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.background = State.user.chatColor;
    });
  }

  function wireColorPopover(prefix) {
    const btn = document.getElementById(`${prefix}ColorBtn`);
    const popover = document.getElementById(`${prefix}ColorPopover`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.cwColorPopover').forEach(p => { if (p !== popover) p.classList.remove('show'); });
      popover.classList.toggle('show');
    });
    popover.querySelectorAll('.cwColorChip').forEach(chip => {
      chip.addEventListener('click', () => { saveChatColor(chip.dataset.color); popover.classList.remove('show'); });
    });
    document.getElementById(`${prefix}ColorCustom`).addEventListener('input', (e) => saveChatColor(e.target.value));
  }

  // -------------------------------------------------------------
  // Envoi de messages
  // -------------------------------------------------------------
  function wireSend(prefix, kind) {
    const input = document.getElementById(`${prefix}Input`);
    const sendBtn = document.getElementById(`${prefix}SendBtn`);
    function send() {
      const text = input.value.trim();
      if (!text || !State.socket) return;
      if (kind === 'general') {
        State.socket.emit('chat:sendGeneral', { text });
      } else {
        State.socket.emit('chat:sendPrivate', { toId: State.activeFriend.id, text });
      }
      input.value = '';
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  // -------------------------------------------------------------
  // Socket.io
  // -------------------------------------------------------------
  function connectSocket() {
    if (typeof io !== 'function') return; // socket.io.js pas chargé sur cette page
    const socket = io('/chat');
    State.socket = socket;

    socket.on('connect', () => {
      loadGeneralHistory(false);
      loadFriends();
    });

    socket.on('chat:general', (m) => {
      State.generalMessages.push(m);
      if (State.generalMessages.length > 200) State.generalMessages.shift();
      if (State.panelOpen && State.activeTab === 'general') renderGeneralBody();
    });

    socket.on('chat:private', (m) => {
      const otherId = m.fromId === State.user.id ? m.toId : m.fromId;
      const cache = State.privateCache[otherId];
      if (cache) {
        cache.messages.push(m);
        if (State.panelOpen && State.activeTab === 'friends' && State.friendsSubview === 'thread' && State.activeFriend && State.activeFriend.id === otherId) {
          renderThreadBody();
          fetch(`/api/chat/private/${otherId}/read`, { method: 'POST' }).catch(() => {});
          return;
        }
      }
      loadFriends(); // rafraîchit les compteurs de non-lus / dernier message
    });

    socket.on('chat:privateError', () => {});
    socket.on('chat:friendRequestReceived', () => loadFriends());
    socket.on('chat:friendAccepted', () => loadFriends());
    socket.on('chat:friendRemoved', () => loadFriends());
  }

  // -------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------
  function switchTab(tab) {
    State.activeTab = tab;
    document.getElementById('cwTabGeneral').classList.toggle('active', tab === 'general');
    document.getElementById('cwTabFriends').classList.toggle('active', tab === 'friends');
    document.getElementById('cwGeneralView').style.display = tab === 'general' ? 'flex' : 'none';
    const showFriendsList = tab === 'friends' && State.friendsSubview === 'list';
    const showThread = tab === 'friends' && State.friendsSubview === 'thread';
    document.getElementById('cwFriendsListView').style.display = showFriendsList ? 'flex' : 'none';
    document.getElementById('cwThreadView').style.display = showThread ? 'flex' : 'none';
    if (tab === 'general') renderGeneralBody();
    if (showFriendsList) renderFriendsBody();
  }

  async function init() {
    let user = null;
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      if (res.ok && data.user) user = data.user;
    } catch (e) { /* pas connecté / erreur réseau : pas de tchat */ }
    if (!user) return;
    State.user = user;

    injectStyles();
    const { btn, panel } = buildDom();
    updateColorSwatches();

    btn.addEventListener('click', () => {
      State.panelOpen = !State.panelOpen;
      panel.classList.toggle('show', State.panelOpen);
      if (State.panelOpen) {
        if (State.activeTab === 'general') renderGeneralBody();
        else if (State.friendsSubview === 'list') renderFriendsBody();
        else renderThreadBody();
      }
    });
    document.getElementById('cwCloseBtn').addEventListener('click', () => {
      State.panelOpen = false;
      panel.classList.remove('show');
    });
    document.getElementById('cwTabGeneral').addEventListener('click', () => switchTab('general'));
    document.getElementById('cwTabFriends').addEventListener('click', () => switchTab('friends'));
    document.getElementById('cwThreadBackBtn').addEventListener('click', closeThread);
    document.getElementById('cwThreadRemoveBtn').addEventListener('click', removeActiveFriend);
    document.addEventListener('click', () => document.querySelectorAll('.cwColorPopover').forEach(p => p.classList.remove('show')));

    wireColorPopover('cwGeneral');
    wireColorPopover('cwThread');
    wireSend('cwGeneral', 'general');
    wireSend('cwThread', 'private');

    connectSocket();
    loadFriends();
    setInterval(loadFriends, 30000); // filet de sécurité si un événement socket est manqué
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
