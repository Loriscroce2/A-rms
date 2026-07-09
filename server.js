// ===================================================================
// server.js — Serveur du jeu A'rms
// Version SQLite (remplace la version MongoDB qui ne démarrait plus)
// ===================================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db'); // Notre base SQLite (voir db.js)
const catalog = require('./cards-catalog');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Nécessaire derrière le proxy HTTPS d'un hébergeur (Railway, Render, etc.)
// pour qu'Express sache que la connexion arrivée est bien sécurisée (https),
// sans quoi les cookies "secure" ne seraient jamais envoyés en production.
app.set('trust proxy', 1);

// --- Config ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET manquant dans le fichier .env — le serveur ne peut pas démarrer.');
  process.exit(1);
}

// --- Middlewares ---
app.use(express.json({ limit: '2mb' })); // relevé pour permettre l'upload d'avatars personnalisés
app.use(cookieParser());

// --- Helpers auth ---
function setAuthCookie(res, user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('arms_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // true seulement en https (prod)
    maxAge: 7 * 24 * 3600 * 1000
  });
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.arms_token;
  if (!token) return res.status(401).json({ error: 'non_auth' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'token_invalid' });
  }
}

// --- Requêtes SQL préparées (users) ---
const qFindUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const qInsertUser = db.prepare(
  'INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)'
);

// --- Requêtes SQL préparées (decks) ---
const qInsertDeck = db.prepare(
  'INSERT INTO decks (user_id, name, cards) VALUES (?, ?, ?)'
);
const qDecksByUser = db.prepare('SELECT * FROM decks WHERE user_id = ?');
const qDeckById = db.prepare('SELECT * FROM decks WHERE id = ?');
const qDeleteDeck = db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?');

// --- Requêtes SQL préparées (collection de cartes) ---
const qCardsByUser = db.prepare('SELECT code, count FROM user_cards WHERE user_id = ?');
const qCardCount = db.prepare('SELECT count FROM user_cards WHERE user_id = ? AND code = ?');
const qUpsertCard = db.prepare(`
  INSERT INTO user_cards (user_id, code, count) VALUES (?, ?, ?)
  ON CONFLICT(user_id, code) DO UPDATE SET count = count + excluded.count
`);
const qSetCardCount = db.prepare('UPDATE user_cards SET count = ? WHERE user_id = ? AND code = ?');

// --- Requêtes SQL préparées (monnaie / récompenses) ---
const qGetCoins = db.prepare('SELECT coins FROM users WHERE id = ?');
const qAddCoins = db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?');
const qSpendCoins = db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?');
const qInsertMatchReward = db.prepare('INSERT OR IGNORE INTO match_rewards (user_id, match_id) VALUES (?, ?)');

// --- Compte(s) administrateur à pièces illimitées ---
// Le solde réel en base n'est jamais modifié : ces comptes ne dépensent
// simplement jamais de pièces (les achats ne débitent rien) et le solde
// affiché au client est toujours un grand nombre fixe.
const UNLIMITED_COINS_EMAILS = new Set(['loris.croce2@gmail.com']);
function hasUnlimitedCoins(req) {
  return !!(req.user && typeof req.user.email === 'string' && UNLIMITED_COINS_EMAILS.has(req.user.email.toLowerCase()));
}
function coinsForResponse(req) {
  if (hasUnlimitedCoins(req)) return 999999999;
  const row = qGetCoins.get(req.user.id);
  return row ? row.coins : 0;
}

// --- Requêtes SQL préparées (profil / avatar) ---
const qGetProfile = db.prepare('SELECT id, name, coins, avatar FROM users WHERE id = ?');
const qSetAvatar = db.prepare('UPDATE users SET avatar = ? WHERE id = ?');

// ===================================================================
// CLASSEMENT "MENACE" (parties classées)
// ===================================================================
// 5 paliers de menace, chacun décliné en 3 niveaux (I/II/III) — 15 rangs au
// total, du plus faible au plus terrifiant. 100 points de Menace séparent
// chaque rang ; le dernier (Extinction III) n'a pas de plafond.
const RANK_TIER_NAMES = ['Mineure', 'Hostile', 'Mortelle', 'Apocalyptique', 'Extinction'];
const POINTS_PER_RANK = 100;
const TOTAL_RANKS = RANK_TIER_NAMES.length * 3; // 15

function rankIndexForPoints(points) {
  const idx = Math.floor(Math.max(0, points) / POINTS_PER_RANK);
  return Math.min(idx, TOTAL_RANKS - 1);
}

function getRankInfo(points) {
  const safePoints = Math.max(0, points || 0);
  const idx = rankIndexForPoints(safePoints);
  const tierIndex = Math.floor(idx / 3);
  const subLevel = (idx % 3) + 1; // 1, 2 ou 3
  const tierName = RANK_TIER_NAMES[tierIndex];
  const romanSub = ['I', 'II', 'III'][subLevel - 1];
  const rankMin = idx * POINTS_PER_RANK;
  const isMaxRank = idx === TOTAL_RANKS - 1;
  const rankMax = isMaxRank ? null : (rankMin + POINTS_PER_RANK - 1);
  return {
    points: safePoints,
    rankIndex: idx,
    tierName,
    subLevel,
    label: `${tierName} ${romanSub}`,
    rankMin,
    rankMax, // null = pas de plafond (Extinction III)
    progressInRank: isMaxRank ? null : (safePoints - rankMin), // 0..99
    isMaxRank,
  };
}

// Facteur K (volatilité) selon le palier ACTUEL du joueur — reprend l'esprit
// de la règle précédente ("de plus en plus punitif à partir de Mortelle"),
// mais s'applique désormais comme amplitude MAXIMALE d'un calcul Elo, pas
// comme un montant fixe.
function kFactorForPoints(points) {
  const idx = rankIndexForPoints(points);
  const tierIndex = Math.floor(idx / 3);
  if (tierIndex <= 1) return 20;   // Mineure / Hostile — débuts cléments
  if (tierIndex === 2) return 28;  // Mortelle
  if (tierIndex === 3) return 34;  // Apocalyptique
  return 40;                        // Extinction
}

// Calcul façon Elo (échecs) : le gain/perte dépend de l'ÉCART DE NIVEAU entre
// les deux adversaires, pas d'un montant fixe.
// - Battre un adversaire largement plus fort rapporte gros ; battre un
//   adversaire largement plus faible rapporte presque rien.
// - Perdre contre un adversaire largement plus fort coûte presque rien (voire
//   rien du tout) ; perdre contre un adversaire largement plus faible coûte
//   très cher.
// myPoints/oppPoints = points de Menace des DEUX joueurs au moment où la
// partie a démarré (figés en début de partie, pas recalculés après coup).
function computeEloDelta(myPoints, oppPoints, won) {
  const expectedScore = 1 / (1 + Math.pow(10, (oppPoints - myPoints) / 400));
  const actualScore = won ? 1 : 0;
  const K = kFactorForPoints(myPoints);
  let delta = Math.round(K * (actualScore - expectedScore));
  if (won && delta < 1) delta = 1; // une victoire rapporte toujours au moins 1 point
  if (!won && delta > 0) delta = 0; // une défaite ne peut jamais faire gagner des points
  return delta;
}

const qGetThreatPoints = db.prepare('SELECT threat_points FROM users WHERE id = ?');
const qApplyRankedResult = db.prepare('UPDATE users SET threat_points = MAX(0, threat_points + ?), ranked_wins = ranked_wins + ?, ranked_losses = ranked_losses + ? WHERE id = ?');
const qLeaderboard = db.prepare(`
  SELECT id, name, avatar, threat_points, ranked_wins, ranked_losses
  FROM users
  WHERE ranked_wins > 0 OR ranked_losses > 0
  ORDER BY threat_points DESC, ranked_wins DESC
  LIMIT ?
`);
const qMyRankPosition = db.prepare(`
  SELECT COUNT(*) + 1 AS position FROM users
  WHERE threat_points > (SELECT threat_points FROM users WHERE id = ?)
    AND (ranked_wins > 0 OR ranked_losses > 0)
`);
// Pour le diagramme de répartition : TOUS les joueurs classés, pas
// seulement le haut du tableau affiché.
const qAllRankedThreatPoints = db.prepare(`
  SELECT threat_points FROM users WHERE ranked_wins > 0 OR ranked_losses > 0
`);

// --- Requêtes SQL préparées (boutique horaire) ---
const qGetShopState = db.prepare('SELECT * FROM shop_state WHERE id = 1');
const qSetShopState = db.prepare(`
  INSERT INTO shop_state (id, hour_bucket, slots) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET hour_bucket = excluded.hour_bucket, slots = excluded.slots
`);
// Achats PAR JOUEUR : un achat n'affecte que celui qui l'a fait, jamais les autres.
const qGetUserShopPurchases = db.prepare('SELECT slot_index FROM shop_purchases WHERE user_id = ? AND hour_bucket = ?');
const qGetUserShopPurchaseOne = db.prepare('SELECT 1 FROM shop_purchases WHERE user_id = ? AND hour_bucket = ? AND slot_index = ?');
const qInsertShopPurchase = db.prepare('INSERT OR IGNORE INTO shop_purchases (user_id, hour_bucket, slot_index) VALUES (?, ?, ?)');

// --- Helper : accorde des cartes à un joueur (upsert additif) ---
function grantCards(userId, codes) {
  const tally = {};
  codes.forEach(code => { tally[code] = (tally[code] || 0) + 1; });
  Object.entries(tally).forEach(([code, n]) => qUpsertCard.run(userId, code, n));
}

// ===================================================================
// API Utilisateurs
// ===================================================================
app.post('/api/signup', (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || name.length < 2) return res.status(400).json({ ok: false, error: 'name_invalid' });
    if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ ok: false, error: 'email_invalid' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'password_short' });

    const emailLower = email.toLowerCase();
    if (qFindUserByEmail.get(emailLower)) {
      return res.status(409).json({ ok: false, error: 'email_taken' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const info = qInsertUser.run(emailLower, name, hash);
    const user = { id: info.lastInsertRowid, email: emailLower, name };
    setAuthCookie(res, user);
    res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const userRow = qFindUserByEmail.get(email.toLowerCase());
    if (!userRow) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

    const ok = bcrypt.compareSync(password, userRow.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

    const user = { id: userRow.id, email: userRow.email, name: userRow.name };
    setAuthCookie(res, user);
    res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('arms_token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const row = qGetProfile.get(req.user.id);
  const tpRow = qGetThreatPoints.get(req.user.id);
  const rank = getRankInfo(tpRow ? tpRow.threat_points : 0);
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email, name: req.user.name, coins: coinsForResponse(req), avatar: row ? row.avatar : '', rank } });
});

// Classement "Menace" : le haut du tableau (100 joueurs par défaut), plus la
// position exacte du joueur connecté (utile même s'il est hors du top 100).
app.get('/api/leaderboard', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const rows = qLeaderboard.all(limit);
    const players = rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      threatInfo: getRankInfo(r.threat_points),
      wins: r.ranked_wins,
      losses: r.ranked_losses,
    }));
    const myTp = qGetThreatPoints.get(req.user.id);
    const myPosition = qMyRankPosition.get(req.user.id);

    // Répartition des joueurs par PALIER (Mineure/Hostile/Mortelle/
    // Apocalyptique/Extinction, tous niveaux I/II/III confondus), sur
    // l'ensemble des joueurs classés — pas seulement le top affiché.
    const allPoints = qAllRankedThreatPoints.all();
    const distributionCounts = {};
    RANK_TIER_NAMES.forEach(t => { distributionCounts[t] = 0; });
    allPoints.forEach(row => {
      const info = getRankInfo(row.threat_points);
      distributionCounts[info.tierName] = (distributionCounts[info.tierName] || 0) + 1;
    });
    const totalRankedPlayers = allPoints.length;
    const distribution = RANK_TIER_NAMES.map(tier => ({
      tierName: tier,
      count: distributionCounts[tier],
      pct: totalRankedPlayers > 0 ? Math.round((distributionCounts[tier] / totalRankedPlayers) * 1000) / 10 : 0,
    }));

    res.json({
      ok: true,
      players,
      distribution,
      totalRankedPlayers,
      me: {
        id: req.user.id,
        threatInfo: getRankInfo(myTp ? myTp.threat_points : 0),
        position: myPosition ? myPosition.position : null,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/profile/avatar', authMiddleware, (req, res) => {
  try {
    const { code, dataUrl } = req.body || {};

    if (dataUrl) {
      // Avatar personnalisé (image uploadée par le joueur, déjà redimensionnée côté client)
      if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
        return res.status(400).json({ ok: false, error: 'invalid_image' });
      }
      if (dataUrl.length > 1_500_000) {
        return res.status(413).json({ ok: false, error: 'image_too_large' });
      }
      qSetAvatar.run(dataUrl, req.user.id);
      return res.json({ ok: true, avatar: dataUrl });
    }

    const c = String(code || '');
    if (!/^\d{4}$/.test(c) || !catalog.ALL_CARDS.some(card => card.code === c)) {
      return res.status(400).json({ ok: false, error: 'invalid_avatar' });
    }
    qSetAvatar.run(c, req.user.id);
    res.json({ ok: true, avatar: c });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// API Decks
// ===================================================================
app.post('/api/decks', authMiddleware, (req, res) => {
  try {
    const { name, cards } = req.body;
    if (!name || !cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'invalid_deck_data' });
    }

    // Vérifie que le joueur possède bien chaque carte, en quantité suffisante
    const needed = {};
    cards.forEach(code => { needed[code] = (needed[code] || 0) + 1; });
    for (const [code, count] of Object.entries(needed)) {
      const row = qCardCount.get(req.user.id, code);
      const owned = row ? row.count : 0;
      if (count > owned) {
        return res.status(400).json({ error: 'card_not_owned', code, owned, requested: count });
      }
    }

    const info = qInsertDeck.run(req.user.id, name, JSON.stringify(cards));
    res.status(201).json({ ok: true, deckId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/decks', authMiddleware, (req, res) => {
  try {
    const rows = qDecksByUser.all(req.user.id);
    const decks = rows.map(d => ({ id: d.id, name: d.name, cards: JSON.parse(d.cards) }));
    res.json({ ok: true, decks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/decks/:deckId', authMiddleware, (req, res) => {
  try {
    const deckId = Number(req.params.deckId);
    if (!Number.isInteger(deckId)) return res.status(400).json({ error: 'invalid_deck_id' });

    const info = qDeleteDeck.run(deckId, req.user.id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'deck_not_found_or_not_authorized' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===================================================================
// API Collection
// ===================================================================
app.get('/api/collection', authMiddleware, (req, res) => {
  try {
    const rows = qCardsByUser.all(req.user.id);
    const coins = coinsForResponse(req);
    const totalCards = rows.reduce((sum, r) => sum + r.count, 0);
    res.json({
      ok: true,
      coins,
      cards: rows, // [{code, count}, ...]
      isFirstLogin: totalCards === 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Ouvre le lot de bienvenue (5 boosters garantissant un deck jouable).
// Ne peut être utilisé qu'une seule fois : refusé si le joueur possède déjà des cartes.
app.post('/api/collection/open-starter', authMiddleware, (req, res) => {
  try {
    const rows = qCardsByUser.all(req.user.id);
    const totalCards = rows.reduce((sum, r) => sum + r.count, 0);
    if (totalCards > 0) {
      return res.status(409).json({ ok: false, error: 'already_opened' });
    }
    const starter = catalog.generateStarterCollection();
    grantCards(req.user.id, starter.codes);
    res.json({ ok: true, boosters: starter.boosters, factions: starter.factions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Revendre le surplus d'une carte (au-delà de 2 exemplaires), 20 pièces/unité
app.post('/api/collection/sell-surplus', authMiddleware, (req, res) => {
  try {
    const { code, quantity } = req.body || {};
    const qty = Number(quantity) || 1;
    if (!code || qty < 1) return res.status(400).json({ ok: false, error: 'invalid_request' });

    const row = qCardCount.get(req.user.id, code);
    const owned = row ? row.count : 0;
    // Seuil de conservation avant revente : 2 exemplaires pour la plupart des cartes,
    // mais 12 pour Dégourat (C214) puisqu'un deck peut en contenir jusqu'à 12.
    const keepThreshold = catalog.maxCopiesFor(code);
    const surplus = Math.max(0, owned - keepThreshold);
    const sellQty = Math.min(qty, surplus);
    if (sellQty <= 0) {
      return res.status(400).json({ ok: false, error: 'no_surplus' });
    }

    qSetCardCount.run(owned - sellQty, req.user.id, code);
    const gain = sellQty * 20;
    qAddCoins.run(gain, req.user.id);
    const coins = coinsForResponse(req);
    res.json({ ok: true, sold: sellQty, gained: gain, coins, remaining: owned - sellQty });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// API Boutique
// ===================================================================
const SHOP_HOUR_MS = 3600 * 1000;

function getOrRefreshShopState() {
  const currentBucket = Math.floor(Date.now() / SHOP_HOUR_MS);
  const row = qGetShopState.get();
  if (row && row.hour_bucket === currentBucket) {
    return { bucket: currentBucket, slots: JSON.parse(row.slots) };
  }
  // Nouvelle heure (ou premier lancement) : on tire 7 nouvelles cartes au hasard.
  // Note : ces emplacements sont communs à tous les joueurs (même carte, même
  // prix pour tout le monde pendant l'heure), mais le fait d'acheter est suivi
  // séparément par joueur (table shop_purchases) — voir plus bas.
  const slots = Array.from({ length: 6 }, () => ({
    code: catalog.randomCard().code,
    price: 200 + Math.floor(Math.random() * 7) * 50, // 200 à 500, palier de 50
  }));
  qSetShopState.run(currentBucket, JSON.stringify(slots));
  return { bucket: currentBucket, slots };
}

app.get('/api/shop/state', authMiddleware, (req, res) => {
  try {
    const state = getOrRefreshShopState();
    const purchasedSlots = new Set(qGetUserShopPurchases.all(req.user.id, state.bucket).map(r => r.slot_index));
    const slots = state.slots.map((s, i) => ({ ...s, sold: purchasedSlots.has(i) }));
    const coins = coinsForResponse(req);
    const msUntilRefresh = SHOP_HOUR_MS - (Date.now() % SHOP_HOUR_MS);
    res.json({ ok: true, slots, coins, msUntilRefresh, boosterPrice: 350 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/shop/buy-listing', authMiddleware, (req, res) => {
  try {
    const slotIndex = Number(req.body?.slotIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
      return res.status(400).json({ ok: false, error: 'invalid_slot' });
    }
    const state = getOrRefreshShopState();
    const slot = state.slots[slotIndex];
    if (!slot) {
      return res.status(409).json({ ok: false, error: 'already_sold' });
    }
    // Achat déjà fait par CE joueur pour cet emplacement, cette heure-ci ?
    // (n'a aucun rapport avec ce que les autres joueurs ont acheté ou non)
    const alreadyBoughtByMe = qGetUserShopPurchaseOne.get(req.user.id, state.bucket, slotIndex);
    if (alreadyBoughtByMe) {
      return res.status(409).json({ ok: false, error: 'already_sold' });
    }
    if (!hasUnlimitedCoins(req)) {
      const spent = qSpendCoins.run(slot.price, req.user.id, slot.price);
      if (spent.changes === 0) {
        return res.status(402).json({ ok: false, error: 'not_enough_coins' });
      }
    }
    qInsertShopPurchase.run(req.user.id, state.bucket, slotIndex);
    grantCards(req.user.id, [slot.code]);
    const coins = coinsForResponse(req);
    res.json({ ok: true, code: slot.code, coins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

const BOOSTER_PRICE = 350;
app.post('/api/shop/buy-booster', authMiddleware, (req, res) => {
  try {
    if (!hasUnlimitedCoins(req)) {
      const spent = qSpendCoins.run(BOOSTER_PRICE, req.user.id, BOOSTER_PRICE);
      if (spent.changes === 0) {
        return res.status(402).json({ ok: false, error: 'not_enough_coins' });
      }
    }
    // Rare (12%) : le booster contient 8 cartes au lieu de 7, présenté comme un coup de chance.
    const lucky = Math.random() < 0.12;
    const codes = catalog.generateRandomBooster(lucky ? 8 : 7);
    grantCards(req.user.id, codes);
    const coins = coinsForResponse(req);
    res.json({ ok: true, codes, coins, lucky });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// API Récompenses de fin de partie
// ===================================================================
app.post('/api/match/result', authMiddleware, (req, res) => {
  try {
    const { matchId, result } = req.body || {};
    if (!matchId || (result !== 'win' && result !== 'loss' && result !== 'forfeit')) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    // Anti-doublon : un seul crédit par (joueur, partie), même en cas de reconnexion/refresh
    const inserted = qInsertMatchReward.run(req.user.id, matchId);
    if (inserted.changes === 0) {
      const coins = coinsForResponse(req);
      const tpRow = qGetThreatPoints.get(req.user.id);
      return res.json({ ok: true, alreadyRewarded: true, coins, gained: 0, rank: getRankInfo(tpRow ? tpRow.threat_points : 0) });
    }

    // Pièces : victoire 50, défaite normale 10, abandon 0.
    const coinGain = (result === 'win') ? 50 : (result === 'loss') ? 10 : 0;
    if (coinGain > 0) qAddCoins.run(coinGain, req.user.id);
    const coins = coinsForResponse(req);

    // Points de Menace : uniquement en partie CLASSÉE, calculés façon Elo
    // (échecs) — l'écart de niveau entre les DEUX joueurs au moment où la
    // partie a démarré détermine l'ampleur du gain/de la perte. Un abandon
    // compte comme une défaite pour ce calcul (pour décourager de fuir une
    // partie perdue), mais ne rapporte jamais de pièces.
    const matchData = mmMatches.get(matchId);
    const isRanked = !!(matchData && matchData.mode === 'ranked' && matchData.ratingsAtStart);
    let pointsDelta = 0;
    let rank = null;
    let previousRank = null;
    if (isRanked) {
      const won = (result === 'win');
      const myPoints = matchData.ratingsAtStart[req.user.id] ?? 0;
      const opponentEntry = (matchData.players || []).find(p => p.userId !== req.user.id);
      const oppPoints = opponentEntry ? (matchData.ratingsAtStart[opponentEntry.userId] ?? 0) : myPoints;

      previousRank = getRankInfo(myPoints);
      pointsDelta = computeEloDelta(myPoints, oppPoints, won);
      qApplyRankedResult.run(pointsDelta, won ? 1 : 0, won ? 0 : 1, req.user.id);

      const afterRow = qGetThreatPoints.get(req.user.id);
      rank = getRankInfo(afterRow ? afterRow.threat_points : 0);
      // Le delta AFFICHÉ doit refléter ce qui a vraiment été appliqué (le
      // plancher à 0 point peut réduire une perte théorique plus grande).
      pointsDelta = rank.points - previousRank.points;
    } else {
      const tpRow = qGetThreatPoints.get(req.user.id);
      rank = getRankInfo(tpRow ? tpRow.threat_points : 0);
    }

    res.json({ ok: true, gained: coinGain, coins, ranked: isRanked, pointsDelta, rank, previousRank });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// Matchmaking
// ===================================================================
function shuffleCodes(codes) {
  const arr = [...codes];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createInitialGameState(players) {
  const playerBottom = players.find(p => p.seat === 'bottom');
  const playerTop = players.find(p => p.seat === 'top');
  const deckBottomRow = qDeckById.get(playerBottom.deckId);
  const deckTopRow = qDeckById.get(playerTop.deckId);
  const profileBottom = qGetProfile.get(playerBottom.userId);
  const profileTop = qGetProfile.get(playerTop.userId);

  return {
    turn: 'bottom',
    deckCodes: {
      bottom: shuffleCodes(JSON.parse(deckBottomRow.cards)),
      top: shuffleCodes(JSON.parse(deckTopRow.cards)),
    },
    profiles: {
      bottom: { name: profileBottom?.name || 'Joueur 1', avatar: profileBottom?.avatar ?? '' },
      top: { name: profileTop?.name || 'Joueur 2', avatar: profileTop?.avatar ?? '' },
    },
  };
}

const mmQueue = [];
const mmTickets = new Map();
const mmMatches = new Map();

function tryMakeMatch() {
  // On ne fait jamais se rencontrer un joueur en Classée avec un joueur en
  // Non classée : on cherche un adversaire du MÊME mode uniquement.
  for (let i = 0; i < mmQueue.length; i++) {
    const a = mmQueue[i];
    const idx = mmQueue.findIndex((x, j) => j > i && x.userId !== a.userId && x.mode === a.mode);
    if (idx === -1) continue;
    const b = mmQueue[idx];
    mmQueue.splice(idx, 1);
    mmQueue.splice(i, 1);

    const matchId = randomUUID();
    const seatA = Math.random() < 0.5 ? 'bottom' : 'top';
    const seatB = seatA === 'bottom' ? 'top' : 'bottom';
    const players = [
      { userId: a.userId, deckId: a.deckId, seat: seatA },
      { userId: b.userId, deckId: b.deckId, seat: seatB }
    ];
    const initialGameState = createInitialGameState(players);

    mmTickets.get(a.ticket).matched = true;
    mmTickets.get(a.ticket).matchId = matchId;
    mmTickets.get(a.ticket).seat = seatA;
    mmTickets.get(b.ticket).matched = true;
    mmTickets.get(b.ticket).matchId = matchId;
    mmTickets.get(b.ticket).seat = seatB;

    // En Classée, on fige les points de Menace de CHAQUE joueur au moment
    // précis où la partie démarre — indispensable pour calculer un gain/perte
    // à la façon des échecs (Elo), basé sur l'écart de niveau entre les deux
    // adversaires plutôt que sur un montant fixe.
    let ratingsAtStart = null;
    if (a.mode === 'ranked') {
      const tpA = qGetThreatPoints.get(a.userId);
      const tpB = qGetThreatPoints.get(b.userId);
      ratingsAtStart = {
        [a.userId]: tpA ? tpA.threat_points : 0,
        [b.userId]: tpB ? tpB.threat_points : 0,
      };
    }

    mmMatches.set(matchId, { createdAt: Date.now(), players, gameState: initialGameState, mode: a.mode, ratingsAtStart });
    return tryMakeMatch(); // au cas où d'autres paires seraient possibles dans la file
  }
}

app.post('/api/matchmaking/join', authMiddleware, (req, res) => {
  try {
    const deckId = req.body?.deckId;
    if (!deckId) return res.status(400).json({ ok: false, error: 'missing_deck' });
    const mode = (req.body?.mode === 'ranked') ? 'ranked' : 'casual';

    const deck = qDeckById.get(deckId);
    if (!deck || deck.user_id !== req.user.id) {
      return res.status(404).json({ ok: false, error: 'deck_not_found' });
    }

    // On nettoie toute ancienne tentative de CE joueur encore en file (onglet fermé
    // sans cliquer "Annuler", rechargement de page, etc.) — sinon ce ticket fantôme
    // peut se faire apparier à la place de la tentative actuelle, et personne ne
    // se rencontre jamais.
    for (let i = mmQueue.length - 1; i >= 0; i--) {
      if (mmQueue[i].userId === req.user.id) {
        mmTickets.delete(mmQueue[i].ticket);
        mmQueue.splice(i, 1);
      }
    }

    const ticket = randomUUID();
    const now = Date.now();
    mmTickets.set(ticket, { userId: req.user.id, deckId, matched: false, matchId: null, seat: null, ts: now, mode });
    mmQueue.push({ ticket, userId: req.user.id, deckId, ts: now, mode });
    tryMakeMatch();

    const sameModeWaiting = mmQueue.filter(e => e.mode === mode).length;
    const estimatedWait = sameModeWaiting > 1 ? 1000 : 5000;
    return res.json({ ok: true, ticket, estimatedWait, mode });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'join_failed' });
  }
});

// NOUVELLE ROUTE — elle manquait, alors que le front-end (play.html)
// l'appelait déjà pour savoir si un adversaire a été trouvé.
app.get('/api/matchmaking/status', authMiddleware, (req, res) => {
  const ticket = req.query?.ticket;
  if (!ticket || !mmTickets.has(ticket)) {
    return res.status(404).json({ ok: false, error: 'ticket_not_found' });
  }
  const t = mmTickets.get(ticket);
  if (t.matched) {
    return res.json({ ok: true, matched: true, matchId: t.matchId, seat: t.seat });
  }
  return res.json({ ok: true, matched: false });
});

app.post('/api/matchmaking/cancel', authMiddleware, (req, res) => {
  const ticket = req.body?.ticket;
  if (!ticket) return res.status(400).json({ ok: false, error: 'missing_ticket' });
  const i = mmQueue.findIndex(e => e.ticket === ticket);
  if (i !== -1) mmQueue.splice(i, 1);
  mmTickets.delete(ticket);
  return res.json({ ok: true });
});

// ===================================================================
// Temps réel (Socket.IO)
// ===================================================================
// ⚠️ Étape suivante (étape 3 de notre plan) : c'est ici qu'on branchera
// vraiment le plateau de jeu (index.html) pour que les actions d'un
// joueur soient validées puis envoyées à l'adversaire. Pour l'instant
// cette partie reste un squelette qui ne fait que gérer la connexion.
const liveMatches = new Map();

io.on('connection', (socket) => {
  socket.on('joinMatch', ({ matchId, seat }) => {
    if (!matchId || (seat !== 'bottom' && seat !== 'top')) return;
    socket.join(matchId);
    let st = liveMatches.get(matchId);
    if (!st) {
      const matchData = mmMatches.get(matchId);
      if (matchData) {
        st = { sockets: { bottom: null, top: null }, gameState: matchData.gameState };
        liveMatches.set(matchId, st);
      } else {
        return;
      }
    }
    st.sockets[seat] = socket.id;
    socket.to(matchId).emit('opponentJoined', { seat });
    if (st.sockets.bottom && st.sockets.top) {
      io.to(matchId).emit('playersReady', { turn: st.gameState.turn });
      io.to(st.sockets.bottom).emit('gameStateUpdate', st.gameState);
      io.to(st.sockets.top).emit('gameStateUpdate', st.gameState);
    }
  });

  socket.on('reqEndTurn', ({ matchId, seat }) => {
    const st = liveMatches.get(matchId);
    if (!st || !st.gameState || st.gameState.turn !== seat) return;
    st.gameState.turn = (st.gameState.turn === 'bottom') ? 'top' : 'bottom';
    liveMatches.set(matchId, st);
    io.to(matchId).emit('doEndTurn', { nextTurn: st.gameState.turn });
  });

  // Relais générique de l'état du jeu : le client qui vient de jouer une
  // action envoie l'état complet, le serveur le transmet tel quel à
  // l'adversaire (et le garde en mémoire pour un rafraîchissement de page).
  socket.on('stateSync', ({ matchId, seat, state }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    st.gameState = state;
    liveMatches.set(matchId, st);
    socket.to(matchId).emit('stateSync', { state, from: seat });
  });

  // Relais simple d'effets visuels transitoires (ex: animation des dés) vers
  // l'autre joueur de la partie, pour qu'il voie la même chose en direct.
  socket.on('vfx', ({ matchId, seat, payload }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    socket.to(matchId).emit('vfx', { seat, payload });
  });

  // Relais brut d'une demande de choix délégué à l'adversaire (ex : Pestrass tuée
  // pendant que ce n'est pas le tour de son propriétaire) et de sa réponse —
  // le serveur ne fait que transmettre, aucune logique de jeu ici.
  socket.on('choiceRequest', ({ matchId, seat, requestId, kind, payload }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    socket.to(matchId).emit('choiceRequest', { seat, requestId, kind, payload });
  });
  socket.on('choiceResponse', ({ matchId, seat, requestId, choice }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    socket.to(matchId).emit('choiceResponse', { seat, requestId, choice });
  });

  // Relais des entrées d'historique de partie vers l'adversaire, pour que
  // chacun voie le déroulé complet (ses actions ET celles de l'autre joueur).
  socket.on('historyEntry', ({ matchId, kind, html, actorSeat }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    socket.to(matchId).emit('historyEntry', { kind, html, actorSeat });
  });

  // Relais du tchat vers l'adversaire, pour une vraie conversation à double sens.
  socket.on('chatMessage', ({ matchId, who, text }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    if (typeof text !== 'string' || !text.trim()) return;
    socket.to(matchId).emit('chatMessage', { who, text: text.slice(0, 500) });
  });

  // Relais des étapes de Krouzpier (choix Cœur/Pique + résultat) vers
  // l'adversaire, pour qu'il voie en direct chaque décision et son issue,
  // même si ce n'est pas lui qui choisit.
  socket.on('krouzpierStep', ({ matchId, step }) => {
    const st = liveMatches.get(matchId);
    if (!st) return;
    socket.to(matchId).emit('krouzpierStep', { step });
  });

  socket.on('action', ({ matchId, seat, type, payload }) => {
    const st = liveMatches.get(matchId);
    if (!st || !st.gameState) return;
    const gs = st.gameState;
    if (gs.turn !== seat) {
      return socket.emit('actionError', { message: "Ce n'est pas votre tour." });
    }
    // TODO (étape 3) : brancher la vraie validation des actions de jeu ici.
    const actionIsValid = false;
    if (actionIsValid) {
      io.to(matchId).emit('gameStateUpdate', gs);
    } else {
      socket.emit('actionError', { message: 'Action invalide (logique de jeu pas encore branchée).' });
    }
  });

  socket.on('disconnect', () => {
    for (const [mid, st] of liveMatches.entries()) {
      let changed = false;
      if (st.sockets.bottom === socket.id) { st.sockets.bottom = null; changed = true; }
      if (st.sockets.top === socket.id) { st.sockets.top = null; changed = true; }
      if (changed) {
        io.to(mid).emit('opponentLeft');
        if (!st.sockets.bottom && !st.sockets.top) {
          liveMatches.delete(mid);
        } else {
          liveMatches.set(mid, st);
        }
      }
    }
  });
});

// ===================================================================
// Fichiers statiques
// ===================================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/cartes', express.static(path.join(__dirname, 'public', 'cartes')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ===================================================================
// Démarrage
// ===================================================================
server.listen(PORT, () => {
  console.log(`✅ Serveur A'rms démarré sur http://localhost:${PORT}`);
});
