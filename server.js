// ===================================================================
// server.js — Serveur du jeu A'rms
// Version SQLite (remplace la version MongoDB qui ne démarrait plus)
// ===================================================================

require('dotenv').config();
const path = require('path');
const fs = require('fs');
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
app.use(express.json({ limit: '2mb' }));
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

// Compte administrateur unique — seul ce compte a accès au panneau
// d'administration (gestion des autres joueurs : pièces, Menace, suppression).
const ADMIN_EMAIL = 'loris.croce2@gmail.com';
function isAdminEmail(email) {
  return !!email && email.toLowerCase() === ADMIN_EMAIL;
}
function adminMiddleware(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// --- Requêtes SQL préparées (users) ---
const qFindUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const qFindUserByNameCI = db.prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?)');
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
const qUpdateDeck = db.prepare('UPDATE decks SET name = ?, cards = ? WHERE id = ? AND user_id = ?');

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
const qGetProfile = db.prepare('SELECT id, name, coins, avatar, has_seen_tutorial, chat_color FROM users WHERE id = ?');
const qSetAvatar = db.prepare('UPDATE users SET avatar = ? WHERE id = ?');
const qSetChatColor = db.prepare('UPDATE users SET chat_color = ? WHERE id = ?');
const qMarkTutorialSeen = db.prepare('UPDATE users SET has_seen_tutorial = 1 WHERE id = ?');

// ===================================================================
// CLASSEMENT "MENACE" (parties classées)
// ===================================================================
// 5 paliers de menace, chacun décliné en 3 niveaux (I/II/III) — 15 rangs au
// total, du plus faible au plus terrifiant. La quantité de points requise
// pour avancer d'un rang N'EST PAS constante : on progresse VITE au début
// (peu de points par rang) et de plus en plus LENTEMENT vers la fin (chaque
// rang coûte davantage) — les tout premiers paliers se débloquent en
// quelques victoires, l'Extinction se mérite sur la durée.
const RANK_TIER_NAMES = ['Mineure', 'Hostile', 'Mortelle', 'Apocalyptique', 'Extinction'];
const TOTAL_RANKS = RANK_TIER_NAMES.length * 3; // 15

// Points nécessaires pour FRANCHIR chaque rang (index 0 = Mineure I → II,
// ... index 13 = Extinction II → III). Croissant par palier.
const RANK_STEP_POINTS = [
  60, 60, 60,       // Mineure   — progression rapide, on prend goût au jeu
  75, 75, 75,       // Hostile
  95, 95, 95,       // Mortelle
  120, 120, 120,    // Apocalyptique
  150, 150, 150,    // Extinction — le sommet se mérite
];
// Seuil cumulé de points pour ATTEINDRE chaque rang.
const RANK_CUM_START = (() => {
  const arr = []; let acc = 0;
  for (let i = 0; i < TOTAL_RANKS; i++) { arr.push(acc); acc += RANK_STEP_POINTS[i]; }
  return arr;
})();

function rankIndexForPoints(points) {
  const safePoints = Math.max(0, points || 0);
  let idx = 0;
  for (let i = TOTAL_RANKS - 1; i >= 0; i--) {
    if (safePoints >= RANK_CUM_START[i]) { idx = i; break; }
  }
  return idx;
}

function getRankInfo(points) {
  const safePoints = Math.max(0, points || 0);
  const idx = rankIndexForPoints(safePoints);
  const tierIndex = Math.floor(idx / 3);
  const subLevel = (idx % 3) + 1; // 1, 2 ou 3
  const tierName = RANK_TIER_NAMES[tierIndex];
  const romanSub = ['I', 'II', 'III'][subLevel - 1];
  const rankMin = RANK_CUM_START[idx];
  const isMaxRank = idx === TOTAL_RANKS - 1;
  const rankMax = isMaxRank ? null : (RANK_CUM_START[idx + 1] - 1);
  const stepSize = RANK_STEP_POINTS[idx];
  return {
    points: safePoints,
    rankIndex: idx,
    tierName,
    subLevel,
    label: `${tierName} ${romanSub}`,
    rankMin,
    rankMax, // null = pas de plafond (Extinction III)
    progressInRank: isMaxRank ? null : (safePoints - rankMin),
    stepSize,
    isMaxRank,
  };
}

// Facteur d'intensité selon le palier ACTUEL du joueur — amplitude du
// Différentiel de Menace (notre propre calcul, voir plus bas). Valeurs
// modérées pour que même les échanges les plus déséquilibrés restent
// lisibles et jamais décourageants.
function kFactorForPoints(points) {
  const idx = rankIndexForPoints(points);
  const tierIndex = Math.floor(idx / 3);
  if (tierIndex <= 1) return 18;   // Mineure / Hostile — débuts cléments
  if (tierIndex === 2) return 24;  // Mortelle
  if (tierIndex === 3) return 28;  // Apocalyptique
  return 32;                        // Extinction
}

const MIN_WIN_GAIN = 20;    // toute victoire rapporte au moins ça — jamais frustrant
const MAX_LOSS_CAP  = 28;   // aucune défaite ne peut coûter plus que ça, même un norme écart
const WIN_GENEROSITY = 2;   // les gains positifs sont amplifiés (généreux sur les exploits)

// Le "Différentiel de Menace" — NOTRE calcul propre à A'rms : le gain/perte
// dépend de l'ÉCART DE NIVEAU entre les deux adversaires, pas d'un montant
// fixe identique pour tout le monde.
// - Battre un adversaire largement plus fort rapporte GROS (généreux) ;
//   battre un adversaire largement plus faible rapporte quand même un
//   minimum garanti (jamais l'impression de "gagner pour rien").
// - Perdre contre un adversaire largement plus fort coûte presque rien (voire
//   rien du tout) ; perdre contre un adversaire largement plus faible coûte
//   cher, mais toujours plafonné pour rester supportable.
// myPoints/oppPoints = points de Menace des DEUX joueurs au moment où la
// partie a démarré (figés en début de partie, pas recalculés après coup).
function computeThreatDifferential(myPoints, oppPoints, won) {
  const expectedScore = 1 / (1 + Math.pow(10, (oppPoints - myPoints) / 400));
  const K = kFactorForPoints(myPoints);
  if (won) {
    let delta = Math.round(K * (1 - expectedScore) * WIN_GENEROSITY);
    return Math.max(delta, MIN_WIN_GAIN);
  } else {
    let delta = Math.round(K * (0 - expectedScore));
    delta = Math.min(delta, 0);
    return Math.max(delta, -MAX_LOSS_CAP);
  }
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

// --- Requêtes SQL préparées (Astrocomptoir — hôtel de vente argent réel) ---
const qGetWallet = db.prepare('SELECT real_balance_cents, paypal_email, astro_agreement_accepted_at, astro_agreement_version, stripe_connect_account_id, stripe_connect_ready FROM users WHERE id = ?');
const qSetPaypalEmail = db.prepare('UPDATE users SET paypal_email = ? WHERE id = ?');
const qAcceptAgreement = db.prepare("UPDATE users SET astro_agreement_accepted_at = datetime('now'), astro_agreement_version = ? WHERE id = ?");
const qAddRealBalance = db.prepare('UPDATE users SET real_balance_cents = real_balance_cents + ? WHERE id = ?');
const qSpendRealBalance = db.prepare('UPDATE users SET real_balance_cents = real_balance_cents - ? WHERE id = ? AND real_balance_cents >= ?');
const qSetStripeConnectAccount = db.prepare('UPDATE users SET stripe_connect_account_id = ? WHERE id = ?');
const qSetStripeConnectReady = db.prepare('UPDATE users SET stripe_connect_ready = ? WHERE id = ?');
const qUserByStripeConnectAccount = db.prepare('SELECT id FROM users WHERE stripe_connect_account_id = ?');

const qInsertListing = db.prepare('INSERT INTO market_listings (seller_id, code, price_cents) VALUES (?, ?, ?)');
const qListingById = db.prepare('SELECT * FROM market_listings WHERE id = ?');
const qMyListings = db.prepare(`
  SELECT * FROM market_listings WHERE seller_id = ? AND status = 'active' ORDER BY id DESC
`);
const qCancelListing = db.prepare("UPDATE market_listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'active'");
const qMarkListingSold = db.prepare("UPDATE market_listings SET status = 'sold', sold_at = datetime('now'), buyer_id = ? WHERE id = ? AND status = 'active'");

// --- Achat direct par carte bancaire (PayPal Checkout) : le temps du
// paiement, on "réserve" l'annonce (status='pending') pour qu'aucun autre
// acheteur ne puisse la prendre. Si le paiement n'aboutit jamais (abandon,
// commande expirée), la réservation est libérée — soit immédiatement au
// retour "annulé", soit via le balayage paresseux ci-dessous (comme le
// bucket horaire de la boutique : recalculé à la lecture, pas de cron
// nécessaire).
const qReserveListingForCheckout = db.prepare(`
  UPDATE market_listings
  SET status = 'pending', paypal_order_id = ?, reserved_until = datetime('now', '+30 minutes')
  WHERE id = ? AND status = 'active'
`);
const qListingByPaypalOrderId = db.prepare('SELECT * FROM market_listings WHERE paypal_order_id = ?');
const qReleaseListingReservation = db.prepare(`
  UPDATE market_listings SET status = 'active', paypal_order_id = NULL, reserved_until = NULL
  WHERE id = ? AND status = 'pending'
`);
const qSweepExpiredListingReservations = db.prepare(`
  UPDATE market_listings SET status = 'active', paypal_order_id = NULL, reserved_until = NULL
  WHERE status = 'pending' AND reserved_until < datetime('now')
`);
const qMarkListingSoldFromPending = db.prepare("UPDATE market_listings SET status = 'sold', sold_at = datetime('now'), buyer_id = ? WHERE id = ? AND status = 'pending'");
const qInsertTransaction = db.prepare(`
  INSERT INTO market_transactions (listing_id, seller_id, buyer_id, code, price_cents, commission_cents, seller_gain_cents)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const qResetMarketTransactions = db.prepare('DELETE FROM market_transactions');
const qMyTransactions = db.prepare(`
  SELECT t.*, su.name AS seller_name, bu.name AS buyer_name FROM market_transactions t
  JOIN users su ON su.id = t.seller_id
  JOIN users bu ON bu.id = t.buyer_id
  WHERE t.seller_id = ? OR t.buyer_id = ?
  ORDER BY t.created_at DESC LIMIT 100
`);

// Marché groupé par carte, pour la zone "à acheter" : jamais ses propres
// annonces (elles vivent dans la zone "mes annonces" via qMyListings).
const qMarketGrouped = db.prepare(`
  SELECT code, MIN(price_cents) AS best_price_cents, COUNT(*) AS active_count
  FROM market_listings
  WHERE status = 'active' AND seller_id != ?
  GROUP BY code
  ORDER BY code ASC
`);
// Priorité prix (le moins cher gagne), puis ancienneté à prix égal — "id"
// est un meilleur tie-break que created_at (résolution à la seconde près,
// deux annonces à la même seconde auraient le même created_at).
const qBestListingForCode = db.prepare(`
  SELECT * FROM market_listings
  WHERE code = ? AND status = 'active' AND seller_id != ?
  ORDER BY price_cents ASC, id ASC
  LIMIT 1
`);
const qCardBestPrice = db.prepare(`SELECT MIN(price_cents) AS best FROM market_listings WHERE code = ? AND status = 'active'`);
const qCardActiveListings = db.prepare(`
  SELECT price_cents, created_at FROM market_listings WHERE code = ? AND status = 'active' ORDER BY price_cents ASC, id ASC
`);
const qCardSoldStats = db.prepare(`SELECT AVG(price_cents) AS avg_price, COUNT(*) AS sold_count FROM market_transactions WHERE code = ?`);
const qMarketHistory = db.prepare(`
  SELECT t.*, su.name AS seller_name FROM market_transactions t
  JOIN users su ON su.id = t.seller_id
  ORDER BY t.created_at DESC LIMIT 100
`);

const qInsertTopup = db.prepare('INSERT INTO wallet_topups (user_id, amount_cents, paypal_order_id, status) VALUES (?, ?, ?, ?)');
const qTopupByOrderId = db.prepare('SELECT * FROM wallet_topups WHERE paypal_order_id = ?');
const qCompleteTopup = db.prepare("UPDATE wallet_topups SET status = 'completed', completed_at = datetime('now') WHERE id = ?");

// BOUTIQUE : achat de lots de pièces contre argent réel (voir COIN_PACKS
// et les routes /api/shop/coins/* plus bas).
const qInsertCoinPurchase = db.prepare('INSERT INTO coin_purchases (user_id, pack_id, coins, amount_cents, paypal_order_id, status) VALUES (?, ?, ?, ?, ?, ?)');
const qCoinPurchaseByOrderId = db.prepare('SELECT * FROM coin_purchases WHERE paypal_order_id = ?');
const qInsertCoinPurchaseStripe = db.prepare("INSERT INTO coin_purchases (user_id, pack_id, coins, amount_cents, provider, stripe_session_id, status) VALUES (?, ?, ?, ?, 'stripe', ?, ?)");
const qCoinPurchaseByStripeSession = db.prepare('SELECT * FROM coin_purchases WHERE stripe_session_id = ?');
const qCompleteCoinPurchase = db.prepare("UPDATE coin_purchases SET status = 'completed', completed_at = datetime('now') WHERE id = ?");

const qInsertWithdrawal = db.prepare('INSERT INTO withdrawal_requests (user_id, amount_cents, paypal_email) VALUES (?, ?, ?)');
const qMyWithdrawals = db.prepare('SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY requested_at DESC');
const qWithdrawalById = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?');
const qPendingWithdrawals = db.prepare(`
  SELECT w.*, u.name AS user_name, u.email AS user_email FROM withdrawal_requests w
  JOIN users u ON u.id = w.user_id
  WHERE w.status = 'pending' ORDER BY w.requested_at ASC
`);
const qMarkWithdrawalPaid = db.prepare("UPDATE withdrawal_requests SET status = 'paid', processed_at = datetime('now'), paypal_payout_batch_id = ? WHERE id = ?");
const qMarkWithdrawalRejected = db.prepare("UPDATE withdrawal_requests SET status = 'rejected', processed_at = datetime('now'), admin_note = ? WHERE id = ?");

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
    // Les pseudos doivent être uniques (insensible à la casse) pour que
    // l'ajout d'ami par pseudo dans le tchat soit toujours sans ambiguïté.
    if (qFindUserByNameCI.get(name)) {
      return res.status(409).json({ ok: false, error: 'name_taken' });
    }

    const hash = bcrypt.hashSync(password, 10);
    let info;
    try {
      info = qInsertUser.run(emailLower, name, hash);
    } catch (e) {
      // Filet de sécurité contre une course entre deux inscriptions
      // simultanées avec le même pseudo (la contrainte UNIQUE de la base
      // rejette la seconde après la vérification ci-dessus).
      if (String(e && e.message).includes('UNIQUE')) {
        return res.status(409).json({ ok: false, error: 'name_taken' });
      }
      throw e;
    }
    const user = { id: info.lastInsertRowid, email: emailLower, name };
    setAuthCookie(res, user);
    if (isAdminEmail(emailLower)) ensureAdminFullCollection();
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
    if (isAdminEmail(userRow.email)) ensureAdminFullCollection();
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
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email, name: req.user.name, coins: coinsForResponse(req), avatar: row ? row.avatar : '', chatColor: row ? row.chat_color : '#7df9ff', rank, hasSeenTutorial: row ? !!row.has_seen_tutorial : false, isAdmin: isAdminEmail(req.user.email) } });
});

// ===================================================================
// ADMINISTRATION — réservé au compte administrateur (voir ADMIN_EMAIL).
// Gestion des autres comptes : pièces, points de Menace, suppression.
// ===================================================================
const qAdminListUsers = db.prepare(`
  SELECT id, email, name, coins, avatar, threat_points, ranked_wins, ranked_losses, created_at
  FROM users ORDER BY created_at DESC
`);
const qAdminSetCoins = db.prepare('UPDATE users SET coins = ? WHERE id = ?');
const qAdminSetThreat = db.prepare('UPDATE users SET threat_points = ? WHERE id = ?');
const qAdminDeleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const qAdminFindUser = db.prepare('SELECT id, email FROM users WHERE id = ?');

// Liste tous les comptes, avec leur rang de Menace calculé.
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const rows = qAdminListUsers.all();
    const users = rows.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      coins: u.coins,
      avatar: u.avatar,
      threatPoints: u.threat_points,
      rank: getRankInfo(u.threat_points),
      rankedWins: u.ranked_wins,
      rankedLosses: u.ranked_losses,
      createdAt: u.created_at,
    }));
    res.json({ ok: true, users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Fixe le solde de pièces d'un compte à une valeur précise.
app.post('/api/admin/users/:id/coins', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const coins = Math.max(0, Math.round(Number(req.body?.coins)));
    if (!Number.isFinite(coins)) return res.status(400).json({ ok: false, error: 'invalid_coins' });
    const target = qAdminFindUser.get(targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    qAdminSetCoins.run(coins, targetId);
    res.json({ ok: true, coins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Fixe les points de Menace d'un compte à une valeur précise.
app.post('/api/admin/users/:id/threat', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const points = Math.max(0, Math.round(Number(req.body?.points)));
    if (!Number.isFinite(points)) return res.status(400).json({ ok: false, error: 'invalid_points' });
    const target = qAdminFindUser.get(targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    qAdminSetThreat.run(points, targetId);
    res.json({ ok: true, points, rank: getRankInfo(points) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Supprime un compte (et tout ce qui lui appartient, via ON DELETE CASCADE :
// decks, collection, récompenses de parties, achats boutique).
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const target = qAdminFindUser.get(targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (isAdminEmail(target.email)) {
      return res.status(400).json({ ok: false, error: 'cannot_delete_admin' });
    }
    qAdminDeleteUser.run(targetId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Accorde la collection COMPLÈTE de la Saison 1 (250 emplacements, 2
// exemplaires chacun) à un compte donné — réservé à l'administrateur.
const qUpsertUserCard = db.prepare(`
  INSERT INTO user_cards (user_id, code, count) VALUES (?, ?, ?)
  ON CONFLICT(user_id, code) DO UPDATE SET count = excluded.count
`);

// Le compte administrateur a TOUJOURS accès à toutes les cartes (1-250 +
// toute la série 'W' de fin de saison), en 2 exemplaires chacune — MAIS
// jamais les jetons (T01-T29), qui restent hors de ce catalogue. Idempotent
// (SET, pas d'addition) : peut être rappelée à volonté (démarrage serveur,
// chaque connexion admin) sans jamais faire gonfler les quantités.
function ensureAdminFullCollection() {
  try {
    const admin = qFindUserByEmail.get(ADMIN_EMAIL);
    if (!admin) return; // compte pas encore créé (première installation)
    const grantAll = db.transaction(() => {
      catalog.SEASON_1_ALL_SLOTS.forEach(slot => {
        qUpsertUserCard.run(admin.id, slot.code, 2);
      });
      (catalog.SEASON_CARDS || []).forEach(c => {
        qUpsertUserCard.run(admin.id, c.code, 2);
      });
    });
    grantAll();
  } catch (e) {
    console.error('[admin-collection] Échec de la mise à jour automatique :', e.message);
  }
}

app.post('/api/admin/users/:id/full-collection', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const target = qAdminFindUser.get(targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    const grantAll = db.transaction(() => {
      catalog.SEASON_1_ALL_SLOTS.forEach(slot => {
        qUpsertUserCard.run(targetId, slot.code, 2);
      });
    });
    grantAll();
    res.json({ ok: true, granted: catalog.SEASON_1_ALL_SLOTS.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// CARTES 'W' DE FIN DE SAISON — distribution liée au rang de Menace.
// Chaque carte de catalog.SEASON_CARDS porte un requiredRankIndex (0-14) :
// tout joueur ayant AU MOINS atteint ce rang y a droit. La distribution
// n'est JAMAIS automatique : elle n'a lieu que lorsque l'administrateur
// clique sur "Débloquer toutes les cartes" (voir bouton admin.html), et
// season_card_grants garde la trace de qui a déjà reçu quoi pour ne
// jamais distribuer deux fois la même carte au même joueur.
// ===================================================================
const qAllUsersForSeasonGrant = db.prepare('SELECT id, email, threat_points FROM users');
const qSeasonGrantExists = db.prepare('SELECT 1 FROM season_card_grants WHERE user_id = ? AND code = ?');
const qInsertSeasonGrant = db.prepare('INSERT INTO season_card_grants (user_id, code) VALUES (?, ?)');

app.post('/api/admin/season-cards/unlock-all', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const users = qAllUsersForSeasonGrant.all();
    let grantedCount = 0;
    const perCard = {};
    (catalog.SEASON_CARDS || []).forEach(c => { perCard[c.code] = 0; });

    const run = db.transaction(() => {
      users.forEach(u => {
        if (isAdminEmail(u.email)) return; // le compte admin a déjà tout en permanence
        const myRankIndex = rankIndexForPoints(u.threat_points);
        (catalog.SEASON_CARDS || []).forEach(c => {
          if (typeof c.requiredRankIndex !== 'number' || myRankIndex < c.requiredRankIndex) return;
          if (qSeasonGrantExists.get(u.id, c.code)) return;
          qInsertSeasonGrant.run(u.id, c.code);
          qUpsertCard.run(u.id, c.code, 1);
          grantedCount++;
          perCard[c.code] = (perCard[c.code] || 0) + 1;
        });
      });
    });
    run();

    res.json({ ok: true, grantedCount, perCard, playersChecked: users.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Marque le didacticiel comme vu, pour ne plus jamais l'afficher
// automatiquement à cet utilisateur (il reste accessible manuellement
// depuis le menu à tout moment). La toute première fois, ça rapporte
// 350 pièces — de quoi s'acheter un booster.
const TUTORIAL_FIRST_TIME_REWARD = 350;
app.post('/api/tutorial/seen', authMiddleware, (req, res) => {
  try {
    const row = db.prepare('SELECT has_seen_tutorial FROM users WHERE id = ?').get(req.user.id);
    const isFirstTime = row ? !row.has_seen_tutorial : false;

    qMarkTutorialSeen.run(req.user.id);

    let gained = 0;
    if (isFirstTime) {
      qAddCoins.run(TUTORIAL_FIRST_TIME_REWARD, req.user.id);
      gained = TUTORIAL_FIRST_TIME_REWARD;
    }
    const coins = coinsForResponse(req);
    res.json({ ok: true, firstTime: isFirstTime, gained, coins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
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

// Dossier contenant les avatars sélectionnables — la liste est TOUJOURS lue
// dynamiquement à chaque appel, pour que les avatars ajoutés plus tard dans
// ce dossier soient automatiquement proposés aux joueurs sans redéploiement.
const AVATAR_DIR = path.join(__dirname, 'public', 'assets', 'Avatar');
const AVATAR_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

function listAvatarFiles() {
  try {
    return fs.readdirSync(AVATAR_DIR).filter(f => AVATAR_EXT_RE.test(f)).sort();
  } catch (e) {
    console.error('Impossible de lire le dossier avatars:', e);
    return [];
  }
}

app.get('/api/avatars', authMiddleware, (req, res) => {
  res.json({ ok: true, avatars: listAvatarFiles() });
});

app.post('/api/profile/avatar', authMiddleware, (req, res) => {
  try {
    const { filename } = req.body || {};

    const f = String(filename || '');
    // On valide contre la liste réelle du dossier (pas de reconstruction de
    // chemin ni de vérification de motif) pour empêcher toute traversée de
    // répertoire — seul un nom de fichier réellement présent est accepté.
    if (!f || !listAvatarFiles().includes(f)) {
      return res.status(400).json({ ok: false, error: 'invalid_avatar' });
    }
    qSetAvatar.run(f, req.user.id);
    res.json({ ok: true, avatar: f });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Couleur de police choisie par le joueur pour ses messages de tchat
// (général + privés) — un simple hexadécimal CSS, validé côté serveur.
const CHAT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
app.post('/api/profile/chat-color', authMiddleware, (req, res) => {
  try {
    const color = String(req.body?.color || '');
    if (!CHAT_COLOR_RE.test(color)) {
      return res.status(400).json({ ok: false, error: 'invalid_color' });
    }
    qSetChatColor.run(color, req.user.id);
    res.json({ ok: true, color });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================================================================
// TCHAT GLOBAL — tchat général (visible de tous) + tchats privés entre
// amis. L'envoi des messages passe par socket.io (voir plus bas, section
// io.of('/chat')) pour le temps réel ; les routes REST ci-dessous servent
// à charger l'historique et à gérer la liste d'amis (recherche par
// pseudo, demandes, acceptation, suppression).
// ===================================================================

const qFindUsersByName = db.prepare(`
  SELECT id, name, avatar FROM users
  WHERE LOWER(name) = LOWER(?) AND id != ?
  LIMIT 20
`);
const qFriendshipBetween = db.prepare(`
  SELECT * FROM friendships
  WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
`);
const qInsertFriendRequest = db.prepare(`
  INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')
`);
const qFriendshipById = db.prepare('SELECT * FROM friendships WHERE id = ?');
const qAcceptFriendship = db.prepare(`
  UPDATE friendships SET status = 'accepted', responded_at = datetime('now') WHERE id = ?
`);
const qDeclineFriendship = db.prepare(`
  UPDATE friendships SET status = 'declined', responded_at = datetime('now') WHERE id = ?
`);
const qDeleteFriendship = db.prepare('DELETE FROM friendships WHERE id = ?');
const qMyAcceptedFriendships = db.prepare(`
  SELECT f.id AS friendship_id,
         CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END AS friend_id
  FROM friendships f
  WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
`);
const qMyIncomingRequests = db.prepare(`
  SELECT f.id AS friendship_id, f.requester_id AS other_id, u.name, u.avatar, f.created_at
  FROM friendships f JOIN users u ON u.id = f.requester_id
  WHERE f.addressee_id = ? AND f.status = 'pending'
  ORDER BY f.created_at DESC
`);
const qMyOutgoingRequests = db.prepare(`
  SELECT f.id AS friendship_id, f.addressee_id AS other_id, u.name, u.avatar, f.created_at
  FROM friendships f JOIN users u ON u.id = f.addressee_id
  WHERE f.requester_id = ? AND f.status = 'pending'
  ORDER BY f.created_at DESC
`);
const qUserBasic = db.prepare('SELECT id, name, avatar FROM users WHERE id = ?');
const qUnreadCountFrom = db.prepare(`
  SELECT COUNT(*) AS n FROM chat_private_messages WHERE from_id = ? AND to_id = ? AND read_at IS NULL
`);
const qLastPrivateMessageBetween = db.prepare(`
  SELECT text, created_at, from_id FROM chat_private_messages
  WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
  ORDER BY id DESC LIMIT 1
`);

const qInsertGeneralMessage = db.prepare('INSERT INTO chat_general_messages (user_id, text) VALUES (?, ?)');
const qGeneralHistory = db.prepare(`
  SELECT m.id, m.user_id, m.text, m.created_at, u.name, u.avatar, u.chat_color
  FROM chat_general_messages m JOIN users u ON u.id = m.user_id
  WHERE m.id < ?
  ORDER BY m.id DESC LIMIT ?
`);
const qGeneralHistoryLatest = db.prepare(`
  SELECT m.id, m.user_id, m.text, m.created_at, u.name, u.avatar, u.chat_color
  FROM chat_general_messages m JOIN users u ON u.id = m.user_id
  ORDER BY m.id DESC LIMIT ?
`);

const qInsertPrivateMessage = db.prepare('INSERT INTO chat_private_messages (from_id, to_id, text) VALUES (?, ?, ?)');
const qPrivateHistory = db.prepare(`
  SELECT m.id, m.from_id, m.to_id, m.text, m.created_at, u.name, u.avatar, u.chat_color
  FROM chat_private_messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.id < ?
  ORDER BY m.id DESC LIMIT ?
`);
const qPrivateHistoryLatest = db.prepare(`
  SELECT m.id, m.from_id, m.to_id, m.text, m.created_at, u.name, u.avatar, u.chat_color
  FROM chat_private_messages m JOIN users u ON u.id = m.from_id
  WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)
  ORDER BY m.id DESC LIMIT ?
`);
const qMarkPrivateRead = db.prepare(`
  UPDATE chat_private_messages SET read_at = datetime('now')
  WHERE from_id = ? AND to_id = ? AND read_at IS NULL
`);

const CHAT_MAX_LEN = 500;
const CHAT_PAGE_SIZE = 50;

function areFriends(userIdA, userIdB) {
  const row = qFriendshipBetween.get(userIdA, userIdB, userIdB, userIdA);
  return !!row && row.status === 'accepted';
}

// Recherche un joueur par pseudo exact (insensible à la casse), pour lui
// envoyer une demande d'ami. Comme le pseudo n'est pas garanti unique,
// plusieurs comptes peuvent être renvoyés — le joueur choisit alors le bon
// (avatar affiché pour l'aider à distinguer).
app.get('/api/chat/find-user', authMiddleware, (req, res) => {
  try {
    const pseudo = String(req.query?.pseudo || '').trim();
    if (!pseudo) return res.json({ ok: true, matches: [] });
    const rows = qFindUsersByName.all(pseudo, req.user.id);
    res.json({ ok: true, matches: rows.map(r => ({ id: r.id, name: r.name, avatar: r.avatar })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/chat/friends/request', authMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.body?.targetId, 10);
    if (!Number.isFinite(targetId) || targetId === req.user.id) {
      return res.status(400).json({ ok: false, error: 'invalid_target' });
    }
    const target = qUserBasic.get(targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const existing = qFriendshipBetween.get(req.user.id, targetId, targetId, req.user.id);
    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ ok: false, error: 'already_friends' });
      }
      if (existing.status === 'pending') {
        // Si l'autre joueur nous avait déjà envoyé une demande, on l'accepte
        // directement au lieu d'en créer une seconde dans l'autre sens.
        if (existing.requester_id === targetId) {
          qAcceptFriendship.run(existing.id);
          notifyUser(targetId, 'chat:friendAccepted', { friendshipId: existing.id, friend: { id: req.user.id, name: req.user.name, avatar: (qUserBasic.get(req.user.id) || {}).avatar || '' } });
          return res.json({ ok: true, status: 'accepted' });
        }
        return res.status(409).json({ ok: false, error: 'request_already_sent' });
      }
      // status === 'declined' : on autorise à retenter, en réinitialisant la ligne existante.
      qDeleteFriendship.run(existing.id);
    }
    const info = qInsertFriendRequest.run(req.user.id, targetId);
    const me = qUserBasic.get(req.user.id);
    notifyUser(targetId, 'chat:friendRequestReceived', {
      friendshipId: info.lastInsertRowid,
      from: { id: me.id, name: me.name, avatar: me.avatar || '' },
    });
    res.status(201).json({ ok: true, status: 'pending', friendshipId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/chat/friends/respond', authMiddleware, (req, res) => {
  try {
    const friendshipId = parseInt(req.body?.friendshipId, 10);
    const accept = !!req.body?.accept;
    const row = qFriendshipById.get(friendshipId);
    if (!row || row.addressee_id !== req.user.id || row.status !== 'pending') {
      return res.status(404).json({ ok: false, error: 'request_not_found' });
    }
    if (accept) {
      qAcceptFriendship.run(friendshipId);
      const me = qUserBasic.get(req.user.id);
      notifyUser(row.requester_id, 'chat:friendAccepted', { friendshipId, friend: { id: me.id, name: me.name, avatar: me.avatar || '' } });
      res.json({ ok: true, status: 'accepted' });
    } else {
      qDeclineFriendship.run(friendshipId);
      res.json({ ok: true, status: 'declined' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Annule une demande d'ami que J'AI envoyée et qui est encore en attente
// (contrairement à /respond, réservé au destinataire).
app.post('/api/chat/friends/cancel', authMiddleware, (req, res) => {
  try {
    const friendshipId = parseInt(req.body?.friendshipId, 10);
    const row = qFriendshipById.get(friendshipId);
    if (!row || row.requester_id !== req.user.id || row.status !== 'pending') {
      return res.status(404).json({ ok: false, error: 'request_not_found' });
    }
    qDeleteFriendship.run(friendshipId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/chat/friends/remove', authMiddleware, (req, res) => {
  try {
    const friendId = parseInt(req.body?.friendId, 10);
    const row = qFriendshipBetween.get(req.user.id, friendId, friendId, req.user.id);
    if (!row || row.status !== 'accepted') {
      return res.status(404).json({ ok: false, error: 'not_friends' });
    }
    qDeleteFriendship.run(row.id);
    notifyUser(friendId, 'chat:friendRemoved', { friendId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/chat/friends', authMiddleware, (req, res) => {
  try {
    const friendRows = qMyAcceptedFriendships.all(req.user.id, req.user.id, req.user.id);
    const friends = friendRows.map(r => {
      const u = qUserBasic.get(r.friend_id);
      const unread = qUnreadCountFrom.get(r.friend_id, req.user.id).n;
      const last = qLastPrivateMessageBetween.get(req.user.id, r.friend_id, r.friend_id, req.user.id);
      return {
        friendshipId: r.friendship_id,
        id: u.id, name: u.name, avatar: u.avatar || '',
        unread,
        online: isUserOnline(u.id),
        lastMessage: last ? last.text : '',
        lastMessageAt: last ? last.created_at : null,
      };
    });
    friends.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
    const incoming = qMyIncomingRequests.all(req.user.id).map(r => ({
      friendshipId: r.friendship_id, id: r.other_id, name: r.name, avatar: r.avatar || '', createdAt: r.created_at,
    }));
    const outgoing = qMyOutgoingRequests.all(req.user.id).map(r => ({
      friendshipId: r.friendship_id, id: r.other_id, name: r.name, avatar: r.avatar || '', createdAt: r.created_at,
    }));
    res.json({ ok: true, friends, incoming, outgoing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/chat/general', authMiddleware, (req, res) => {
  try {
    const before = parseInt(req.query?.before, 10);
    const rows = Number.isFinite(before)
      ? qGeneralHistory.all(before, CHAT_PAGE_SIZE)
      : qGeneralHistoryLatest.all(CHAT_PAGE_SIZE);
    const messages = rows.map(r => ({
      id: r.id, userId: r.user_id, name: r.name, avatar: r.avatar || '', color: r.chat_color || '#7df9ff',
      text: r.text, createdAt: r.created_at,
    })).reverse();
    res.json({ ok: true, messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/chat/private/:friendId', authMiddleware, (req, res) => {
  try {
    const friendId = parseInt(req.params.friendId, 10);
    if (!areFriends(req.user.id, friendId)) {
      return res.status(403).json({ ok: false, error: 'not_friends' });
    }
    const before = parseInt(req.query?.before, 10);
    const rows = Number.isFinite(before)
      ? qPrivateHistory.all(req.user.id, friendId, friendId, req.user.id, before, CHAT_PAGE_SIZE)
      : qPrivateHistoryLatest.all(req.user.id, friendId, friendId, req.user.id, CHAT_PAGE_SIZE);
    const messages = rows.map(r => ({
      id: r.id, fromId: r.from_id, toId: r.to_id, name: r.name, avatar: r.avatar || '', color: r.chat_color || '#7df9ff',
      text: r.text, createdAt: r.created_at,
    })).reverse();
    qMarkPrivateRead.run(friendId, req.user.id);
    res.json({ ok: true, messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Marque comme lus les messages d'un ami sans recharger tout l'historique
// (appelé quand un message arrive en direct pendant que la conversation est
// déjà ouverte à l'écran).
app.post('/api/chat/private/:friendId/read', authMiddleware, (req, res) => {
  try {
    const friendId = parseInt(req.params.friendId, 10);
    qMarkPrivateRead.run(friendId, req.user.id);
    res.json({ ok: true });
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

// Modifie un deck EXISTANT (nom et/ou cartes) — même validation de
// possession que la création. Le deck doit appartenir à l'utilisateur
// connecté (vérifié par la clause WHERE ... AND user_id = ? de qUpdateDeck).
app.put('/api/decks/:deckId', authMiddleware, (req, res) => {
  try {
    const deckId = Number(req.params.deckId);
    if (!Number.isInteger(deckId)) return res.status(400).json({ error: 'invalid_deck_id' });

    const { name, cards } = req.body;
    if (!name || !cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'invalid_deck_data' });
    }

    const needed = {};
    cards.forEach(code => { needed[code] = (needed[code] || 0) + 1; });
    for (const [code, count] of Object.entries(needed)) {
      const row = qCardCount.get(req.user.id, code);
      const owned = row ? row.count : 0;
      if (count > owned) {
        return res.status(400).json({ error: 'card_not_owned', code, owned, requested: count });
      }
    }

    const info = qUpdateDeck.run(name, JSON.stringify(cards), deckId, req.user.id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'deck_not_found_or_not_authorized' });
    }
    res.json({ ok: true });
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

    // Points de Menace : uniquement en partie CLASSÉE, calculés via NOTRE
    // Différentiel de Menace — l'écart de niveau entre les DEUX joueurs au
    // moment où la
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
      pointsDelta = computeThreatDifferential(myPoints, oppPoints, won);
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

  // Tirage au sort pour déterminer qui commence : chaque joueur tire une
  // carte au hasard parmi les 250 emplacements de la Saison 1 — le numéro
  // le plus élevé l'emporte et commence la partie. Calculé ICI, côté
  // serveur, pour être équitable (impossible à truquer côté client) et
  // identique pour les deux joueurs une fois diffusé.
  const bottomDrawNum = 1 + Math.floor(Math.random() * 250);
  let topDrawNum = 1 + Math.floor(Math.random() * 250);
  while (topDrawNum === bottomDrawNum) { topDrawNum = 1 + Math.floor(Math.random() * 250); } // pas d'égalité
  const firstSeat = bottomDrawNum > topDrawNum ? 'bottom' : 'top';
  const compensationSeat = firstSeat === 'bottom' ? 'top' : 'bottom';

  return {
    turn: firstSeat,
    firstSeat,
    // Le joueur qui NE commence PAS reçoit 1 carte de compensation dans sa
    // main de départ (7 au lieu de 6), pour rééquilibrer l'absence
    // d'initiative — valable en Classée comme en Non classée.
    compensationSeat,
    drawReveal: {
      bottom: catalog.pad4(bottomDrawNum),
      top: catalog.pad4(topDrawNum),
    },
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

// Écart de points de Menace toléré entre deux joueurs, selon le temps
// d'attente déjà écoulé — commence strict (adversaires vraiment proches),
// puis s'élargit progressivement pour ne jamais laisser quelqu'un attendre
// indéfiniment faute d'adversaire suffisamment proche.
function allowedRatingGap(waitMs) {
  if (waitMs < 6000) return 150;   // < 6s   : très proche uniquement
  if (waitMs < 15000) return 300;  // < 15s  : élargi
  if (waitMs < 30000) return 600;  // < 30s  : encore plus large
  return Infinity;                  // 30s+   : n'importe qui, pour garantir une partie
}

function tryMakeMatch() {
  const now = Date.now();
  for (let i = 0; i < mmQueue.length; i++) {
    const a = mmQueue[i];
    let bestIdx = -1, bestGap = Infinity;

    for (let j = 0; j < mmQueue.length; j++) {
      if (j === i) continue;
      const b = mmQueue[j];
      if (b.userId === a.userId || b.mode !== a.mode) continue;

      if (a.mode === 'ranked') {
        // On ne fait jamais se rencontrer deux joueurs de rangs trop
        // éloignés — sauf si l'un des deux attend depuis assez longtemps
        // pour élargir la recherche. Parmi tous les candidats valides, on
        // choisit toujours celui dont le rang est le PLUS PROCHE.
        const gap = Math.abs((a.rating || 0) - (b.rating || 0));
        const allowed = Math.max(allowedRatingGap(now - a.ts), allowedRatingGap(now - b.ts));
        if (gap > allowed) continue;
        if (gap < bestGap) { bestGap = gap; bestIdx = j; }
      } else {
        // Non classée : le rang n'a aucune importance, le premier adversaire
        // disponible convient — on privilégie la rapidité d'appariement.
        bestIdx = j;
        break;
      }
    }

    if (bestIdx === -1) continue;
    const b = mmQueue[bestIdx];

    // Retire les deux entrées (le plus grand index d'abord pour ne pas
    // décaler la position de l'autre pendant la suppression).
    const [iLo, iHi] = i < bestIdx ? [i, bestIdx] : [bestIdx, i];
    mmQueue.splice(iHi, 1);
    mmQueue.splice(iLo, 1);

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
    // via notre Différentiel de Menace, basé sur l'écart de niveau entre les deux
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
    // En Classée, on retient le rang ACTUEL du joueur pour le matchmaking par
    // proximité (voir tryMakeMatch/allowedRatingGap) — inutile en Non classée.
    let rating = 0;
    if (mode === 'ranked') {
      const tpRow = qGetThreatPoints.get(req.user.id);
      rating = tpRow ? tpRow.threat_points : 0;
    }
    mmTickets.set(ticket, { userId: req.user.id, deckId, matched: false, matchId: null, seat: null, ts: now, mode });
    mmQueue.push({ ticket, userId: req.user.id, deckId, ts: now, mode, rating });
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
// ASTROCOMPTOIR — hôtel de vente entre joueurs, argent réel via PayPal.
// Modèle "portefeuille interne" : on recharge son solde via PayPal
// Checkout, on achète/vend des cartes avec ce solde (10% de commission
// prélevée sur chaque vente), et on retire son solde vers son PayPal
// quand on veut (validé manuellement par un administrateur avant l'envoi
// réel — voir /api/admin/astrocomptoir/withdrawals/:id/approve).
// ===================================================================

// --- PayPal : appels réels à l'API REST (Orders v2 pour les recharges,
// Payouts v1 pour les retraits). Ne fonctionnent QUE si PAYPAL_CLIENT_ID
// et PAYPAL_CLIENT_SECRET sont renseignés dans .env (voir .env.example) —
// sans ça, les routes concernées renvoient 'paypal_not_configured' plutôt
// que de planter. Pour activer les vrais paiements : créer une App sur
// developer.paypal.com avec un compte PayPal Business, copier son Client
// ID / Secret dans .env, régler PAYPAL_MODE sur "sandbox" pour tester ou
// "live" pour du vrai argent.
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_API_BASE = (process.env.PAYPAL_MODE === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
function isPaypalConfigured() { return !!(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET); }

// --- Stripe : paiement direct par carte bancaire (alternative à PayPal),
// via Checkout Session (page de paiement hébergée par Stripe — pas besoin
// de manipuler de numéro de carte côté serveur). L'argent encaissé est
// automatiquement viré par Stripe vers le compte bancaire (IBAN) associé au
// compte Stripe propriétaire de STRIPE_SECRET_KEY, tous les quelques jours —
// jamais de portefeuille intermédiaire. Appels en fetch brut (pas de SDK
// Stripe) pour rester cohérent avec l'intégration PayPal ci-dessus et éviter
// d'ajouter une dépendance npm.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
function isStripeConfigured() { return !!STRIPE_SECRET_KEY; }
function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64');
}

// `connect` (optionnel) = { destinationAccountId, applicationFeeAmount } —
// utilisé pour les ventes de l'Astrocomptoir : Stripe répartit AUTOMATIQUEMENT
// le paiement dès l'encaissement (destination charge), la part du vendeur
// atterrit directement sur son propre compte Stripe Connect, la commission
// reste sur le compte du jeu. Aucune écriture manuelle de solde nécessaire.
async function stripeCreateCheckoutSession(amountCents, productName, successUrl, cancelUrl, imageUrl, connect) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('line_items[0][price_data][currency]', 'eur');
  params.append('line_items[0][price_data][product_data][name]', productName);
  if (imageUrl) params.append('line_items[0][price_data][product_data][images][0]', imageUrl);
  params.append('line_items[0][price_data][unit_amount]', String(amountCents));
  params.append('line_items[0][quantity]', '1');
  // "Managed Payments" (activé par défaut sur les comptes Stripe récents)
  // exige un code fiscal produit qu'on n'a pas configuré — on le désactive
  // pour cette requête, comme suggéré par l'erreur Stripe elle-même. Pas
  // besoin de Stripe Tax pour de la monnaie de jeu vendue en direct.
  params.append('managed_payments[enabled]', 'false');
  if (connect && connect.destinationAccountId) {
    params.append('payment_intent_data[transfer_data][destination]', connect.destinationAccountId);
    params.append('payment_intent_data[application_fee_amount]', String(connect.applicationFeeAmount));
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe] création de session échouée', res.status, errBody);
    throw new Error(`stripe_create_session_failed_${res.status}`);
  }
  return res.json();
}

async function stripeRetrieveSession(sessionId) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': stripeAuthHeader() },
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe] lecture de session échouée', res.status, errBody);
    throw new Error(`stripe_retrieve_session_failed_${res.status}`);
  }
  return res.json();
}

// --- Stripe Connect : compte "Express" par vendeur (identité + IBAN via une
// page hébergée par Stripe), pour recevoir automatiquement sa part de chaque
// vente et retirer vers son propre compte bancaire. Payouts en mode "manual"
// (pas de virement automatique planifié par Stripe) pour que le retrait ne
// parte que lorsque le joueur clique sur "Retrait" dans le jeu.
async function stripeCreateConnectedAccount(email) {
  const params = new URLSearchParams();
  params.append('type', 'express');
  params.append('country', 'FR');
  params.append('email', email);
  params.append('capabilities[transfers][requested]', 'true');
  params.append('business_type', 'individual');
  params.append('settings[payouts][schedule][interval]', 'manual');
  const res = await fetch('https://api.stripe.com/v1/accounts', {
    method: 'POST',
    headers: { 'Authorization': stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe connect] création de compte échouée', res.status, errBody);
    throw new Error(`stripe_connect_account_failed_${res.status}`);
  }
  return res.json();
}

async function stripeCreateAccountLink(accountId, refreshUrl, returnUrl) {
  const params = new URLSearchParams();
  params.append('account', accountId);
  params.append('refresh_url', refreshUrl);
  params.append('return_url', returnUrl);
  params.append('type', 'account_onboarding');
  const res = await fetch('https://api.stripe.com/v1/account_links', {
    method: 'POST',
    headers: { 'Authorization': stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe connect] création du lien d\'onboarding échouée', res.status, errBody);
    throw new Error(`stripe_connect_link_failed_${res.status}`);
  }
  return res.json();
}

async function stripeRetrieveAccount(accountId) {
  const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
    headers: { 'Authorization': stripeAuthHeader() },
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe connect] lecture de compte échouée', res.status, errBody);
    throw new Error(`stripe_connect_account_read_failed_${res.status}`);
  }
  return res.json();
}

async function stripeRetrieveConnectedBalance(accountId) {
  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { 'Authorization': stripeAuthHeader(), 'Stripe-Account': accountId },
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe connect] lecture de solde échouée', res.status, errBody);
    throw new Error(`stripe_connect_balance_failed_${res.status}`);
  }
  return res.json();
}

async function stripeCreatePayoutForAccount(accountId, amountCents) {
  const params = new URLSearchParams();
  params.append('amount', String(amountCents));
  params.append('currency', 'eur');
  const res = await fetch('https://api.stripe.com/v1/payouts', {
    method: 'POST',
    headers: {
      'Authorization': stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Account': accountId,
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[stripe connect] création du virement échouée', res.status, errBody);
    throw new Error(`stripe_connect_payout_failed_${res.status}`);
  }
  return res.json();
}

// ===================================================================
// BOUTIQUE — 5 lots de pièces à acheter contre argent réel (PayPal).
// Base redemandée explicitement : 700 pièces pour 2,99€ (palier 1), puis
// tarifs et quantités de pièces croissants avec un taux dégressif (de
// plus en plus de pièces par euro à mesure qu'on monte en gamme), pour
// récompenser les gros achats — jusqu'à +71% de pièces au meilleur tarif
// sur le plus gros lot par rapport au taux du premier palier.
// ===================================================================
const COIN_PACKS = [
  { id: 'petite-bourse', coins: 700,   amountCents: 299,  label: 'Petite bourse', icon: 'bourse1.png', bonusPct: 0  },
  { id: 'grande-bourse', coins: 1500,  amountCents: 599,  label: 'Grande bourse', icon: 'bourse2.png', bonusPct: 7  },
  { id: 'maxi-bourses',  coins: 3200,  amountCents: 1099, label: 'Maxi bourses',  icon: 'bourse3.png', bonusPct: 24 },
  { id: 'coffre',        coins: 7000,  amountCents: 1999, label: 'Coffre',        icon: 'coffre.png',  bonusPct: 50 },
  { id: 'tresor',        coins: 16000, amountCents: 3999, label: 'Trésor',        icon: 'tresor.png',  bonusPct: 71 },
];
function getCoinPack(id) { return COIN_PACKS.find(p => p.id === id) || null; }

async function paypalGetAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`paypal_oauth_failed_${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function paypalCreateOrder(amountEuros, returnUrl, cancelUrl, description, brandName) {
  const token = await paypalGetAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        description: description || "Recharge du portefeuille Astrocomptoir — A'rms",
        amount: { currency_code: 'EUR', value: amountEuros.toFixed(2) },
      }],
      application_context: {
        brand_name: brandName || "A'rms — Astrocomptoir",
        user_action: 'PAY_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });
  if (!res.ok) throw new Error(`paypal_create_order_failed_${res.status}`);
  return res.json();
}

async function paypalCaptureOrder(orderId) {
  const token = await paypalGetAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`paypal_capture_failed_${res.status}`);
  return res.json();
}

// Une capture PayPal réussie renvoie le détail exact de ce qui atterrit
// vraiment sur le compte (seller_receivable_breakdown.net_amount), après
// déduction des frais PayPal — jamais le montant brut payé par l'acheteur.
// Sur une petite carte, ces frais peuvent représenter une grosse part du
// prix (frais fixe + pourcentage), donc partager la commission sur le
// montant NET plutôt que sur le prix affiché garantit que le site ne
// promet jamais aux vendeurs plus d'argent qu'il n'en a réellement reçu.
function extractNetAmountCents(capture, fallbackCents) {
  try {
    const netStr = capture?.purchase_units?.[0]?.payments?.captures?.[0]
      ?.seller_receivable_breakdown?.net_amount?.value;
    if (netStr) return Math.round(parseFloat(netStr) * 100);
  } catch (e) { /* structure inattendue : on retombe sur le montant brut */ }
  return fallbackCents;
}

async function paypalSendPayout(email, amountEuros, note, senderBatchId) {
  const token = await paypalGetAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: "Votre retrait Astrocomptoir — A'rms",
        email_message: note,
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: amountEuros.toFixed(2), currency: 'EUR' },
        receiver: email,
        note,
        sender_item_id: senderBatchId,
      }],
    }),
  });
  if (!res.ok) {
    // On journalise le corps exact renvoyé par PayPal (name/message/details)
    // pour pouvoir diagnostiquer un échec de retrait sans aller-retour :
    // un 403 seul ne dit pas SI c'est "Payouts non activé", des identifiants
    // sandbox utilisés en live, ou autre chose.
    let body = null;
    try { body = await res.json(); } catch (e) { /* réponse non-JSON, tant pis */ }
    console.error(`[paypal] Échec de l'envoi du Payout (HTTP ${res.status}) :`, JSON.stringify(body));
    throw new Error(`paypal_payout_failed_${res.status}`);
  }
  return res.json();
}

// Version de l'accord légal Astrocomptoir : si son texte change un jour, on
// incrémente cette valeur (ex. 'v2') — chaque joueur devra alors le
// réaccepter avant de pouvoir de nouveau acheter/vendre/retirer, même s'il
// avait déjà coché la version précédente.
const ASTRO_AGREEMENT_VERSION = 'v1';
function hasAcceptedAgreement(userId) {
  const row = qGetWallet.get(userId);
  return !!row && row.astro_agreement_version === ASTRO_AGREEMENT_VERSION;
}

const ASTRO_COMMISSION_RATE = 0.10;
const ASTRO_MIN_LISTING_CENTS = 50;      // 0,50 €
const ASTRO_MAX_LISTING_CENTS = 100000;  // 1000 €
const ASTRO_MIN_TOPUP_CENTS = 200;       // 2 €
const ASTRO_MAX_TOPUP_CENTS = 50000;     // 500 €
// En dessous de 10 €, la part fixe des frais PayPal (0,35 €) prélevée sur le
// retrait dévore une proportion disproportionnée du montant (jusqu'à ~38 %
// pour 1 €) — ce plancher garde ce prélèvement sous ~6,5 %, un niveau
// raisonnable. Voir estimateWithdrawNetCents côté astrocomptoir.html pour
// l'estimation en direct affichée au joueur.
const ASTRO_MIN_WITHDRAWAL_CENTS = 1000; // 10 €

// --- Portefeuille / accord légal ---
app.get('/api/astrocomptoir/status', authMiddleware, (req, res) => {
  try {
    const row = qGetWallet.get(req.user.id);
    res.json({
      ok: true,
      balanceCents: row.real_balance_cents,
      paypalEmail: row.paypal_email || '',
      agreementAccepted: row.astro_agreement_version === ASTRO_AGREEMENT_VERSION,
      agreementVersion: ASTRO_AGREEMENT_VERSION,
      paypalConfigured: isPaypalConfigured(),
      stripeConfigured: isStripeConfigured(),
      stripeConnectReady: !!row.stripe_connect_ready,
      hasStripeConnectAccount: !!row.stripe_connect_account_id,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/astrocomptoir/agreement/accept', authMiddleware, (req, res) => {
  try {
    qAcceptAgreement.run(ASTRO_AGREEMENT_VERSION, req.user.id);
    res.json({ ok: true, agreementVersion: ASTRO_AGREEMENT_VERSION });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/astrocomptoir/paypal-email', authMiddleware, (req, res) => {
  try {
    // Déconnexion explicite : efface l'adresse enregistrée, le joueur devra
    // en connecter une nouvelle avant son prochain retrait.
    if (req.body?.disconnect === true) {
      qSetPaypalEmail.run('', req.user.id);
      return res.json({ ok: true, paypalEmail: '' });
    }
    const email = String(req.body?.email || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'email_invalid' });
    }
    qSetPaypalEmail.run(email, req.user.id);
    res.json({ ok: true, paypalEmail: email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Demande de retrait vers PayPal (validation manuelle par un admin) ---
// Débite immédiatement le solde interne (pour ne jamais permettre un double
// retrait du même montant) et crée une demande 'pending'. AUCUN appel à
// l'API PayPal Payouts ici : l'administrateur envoie l'argent lui-même,
// manuellement, depuis son propre compte PayPal, puis confirme l'envoi
// depuis le panneau d'administration (voir /api/admin/astrocomptoir/
// withdrawals/:id/approve) — ce qui marque la demande comme payée. Ce choix
// contourne volontairement l'API Payouts, bloquée côté PayPal en attente de
// validation de leur part (AUTHORIZATION_ERROR), sans dépendre de ce blocage
// pour que les joueurs puissent retirer leur argent dès maintenant.
app.post('/api/astrocomptoir/withdraw', authMiddleware, async (req, res) => {
  try {
    if (!hasAcceptedAgreement(req.user.id)) {
      return res.status(403).json({ ok: false, error: 'agreement_required' });
    }
    const wallet = qGetWallet.get(req.user.id);
    if (!wallet.paypal_email) return res.status(400).json({ ok: false, error: 'paypal_email_missing' });
    const amountCents = Math.round(Number(req.body?.amountCents));
    // Minimum de 10 € : en dessous, la part fixe des frais PayPal prélevés
    // sur l'envoi (voir estimateWithdrawNetCents côté client) dévore une
    // proportion disproportionnée du montant demandé.
    if (!Number.isFinite(amountCents) || amountCents < ASTRO_MIN_WITHDRAWAL_CENTS) {
      return res.status(400).json({ ok: false, error: 'amount_below_minimum' });
    }
    const spent = qSpendRealBalance.run(amountCents, req.user.id, amountCents);
    if (spent.changes === 0) {
      return res.status(402).json({ ok: false, error: 'insufficient_balance' });
    }
    qInsertWithdrawal.run(req.user.id, amountCents, wallet.paypal_email);
    const freshWallet = qGetWallet.get(req.user.id);
    res.json({ ok: true, pending: true, balanceCents: freshWallet.real_balance_cents });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Zone 1 : cartes que CE joueur peut acheter (groupées par carte, prix
// le plus bas en avant) — on ne compte jamais ses propres annonces ici,
// elles vivent dans la zone 2 (voir /listings juste après). ---
app.get('/api/astrocomptoir/market', authMiddleware, (req, res) => {
  try {
    qSweepExpiredListingReservations.run();
    const rows = qMarketGrouped.all(req.user.id);
    const market = rows.map(r => ({ code: r.code, bestPriceCents: r.best_price_cents, activeCount: r.active_count }));
    res.json({ ok: true, market });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Zone 2 : MES annonces actives (mise en vente / annulation) ---
app.get('/api/astrocomptoir/listings', authMiddleware, (req, res) => {
  try {
    const rows = qMyListings.all(req.user.id);
    const listings = rows.map(r => ({ id: r.id, code: r.code, priceCents: r.price_cents, createdAt: r.created_at }));
    res.json({ ok: true, listings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Stats d'une carte : meilleur prix actuel, prix moyen des ventes
// réussies, et détail des annonces actives (sert à la fois à l'encart
// affiché au clic sur une carte, ET au pop-up de file d'attente affiché
// avant de mettre en vente au même tarif qu'une annonce existante). ---
app.get('/api/astrocomptoir/cards/:code/stats', authMiddleware, (req, res) => {
  try {
    const code = String(req.params.code || '');
    const best = qCardBestPrice.get(code);
    const sold = qCardSoldStats.get(code);
    const active = qCardActiveListings.all(code);
    res.json({
      ok: true,
      code,
      bestPriceCents: (best && best.best !== null) ? best.best : null,
      avgSoldPriceCents: (sold && sold.avg_price !== null) ? Math.round(sold.avg_price) : null,
      soldCount: sold ? sold.sold_count : 0,
      activeListings: active.map(a => ({ priceCents: a.price_cents, createdAt: a.created_at })),
      activeCount: active.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Historique général du marché : les ventes conclues par TOUS les
// joueurs (nom du vendeur uniquement — jamais l'acheteur, par discrétion).
// Distinct de /transactions ci-dessous, qui lui ne montre QUE les vôtres. ---
app.get('/api/astrocomptoir/market-history', authMiddleware, (req, res) => {
  try {
    const rows = qMarketHistory.all();
    const sales = rows.map(r => ({ code: r.code, priceCents: r.price_cents, sellerName: r.seller_name, createdAt: r.created_at }));
    res.json({ ok: true, sales });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/astrocomptoir/listings', authMiddleware, (req, res) => {
  try {
    if (!hasAcceptedAgreement(req.user.id)) {
      return res.status(403).json({ ok: false, error: 'agreement_required' });
    }
    const code = String(req.body?.code || '');
    const priceCents = Math.round(Number(req.body?.priceCents));
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
    if (!Number.isFinite(priceCents) || priceCents < ASTRO_MIN_LISTING_CENTS || priceCents > ASTRO_MAX_LISTING_CENTS) {
      return res.status(400).json({ ok: false, error: 'invalid_price' });
    }
    const row = qCardCount.get(req.user.id, code);
    const owned = row ? row.count : 0;
    if (owned < 1) return res.status(400).json({ ok: false, error: 'card_not_owned' });
    // La carte quitte immédiatement la collection utilisable (deckbuilding
    // compris) tant que l'annonce est active — rendue si annulée.
    qSetCardCount.run(owned - 1, req.user.id, code);
    const info = qInsertListing.run(req.user.id, code, priceCents);
    res.status(201).json({ ok: true, listingId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.delete('/api/astrocomptoir/listings/:id', authMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const listing = qListingById.get(id);
    if (!listing || listing.seller_id !== req.user.id || listing.status !== 'active') {
      return res.status(404).json({ ok: false, error: 'listing_not_found' });
    }
    const info = qCancelListing.run(id, req.user.id);
    if (info.changes === 0) return res.status(409).json({ ok: false, error: 'already_resolved' });
    qUpsertCard.run(req.user.id, listing.code, 1);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Nom lisible d'une carte pour l'affichage côté Stripe (titre du produit sur
// la page de paiement) — lu depuis card-catalog.json (généré au démarrage),
// mis en cache en mémoire, avec un repli sur le code si jamais introuvable.
let _cardCatalogNameCache = null;
function cardCatalogName(code) {
  try {
    if (!_cardCatalogNameCache) {
      const p = path.join(__dirname, 'public', 'data', 'card-catalog.json');
      _cardCatalogNameCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    return (_cardCatalogNameCache[code] && _cardCatalogNameCache[code].name) || `Carte ${code}`;
  } catch (e) {
    return `Carte ${code}`;
  }
}

// Achat par CARTE (et non plus par annonce précise) : le serveur choisit
// toujours automatiquement la meilleure annonce active — la moins chère,
// et à prix égal la plus ANCIENNE (priorité prix puis ancienneté, comme un
// vrai carnet d'ordres). Le joueur n'a jamais à choisir "chez qui" acheter.
//
// Achat en argent réel = paiement DIRECT par carte bancaire via PayPal
// Checkout, pour le prix exact de l'annonce — plus besoin d'un solde
// préchargé. L'annonce est réservée ('pending') le temps du paiement pour
// qu'aucun autre acheteur ne puisse la prendre entre-temps ; si le paiement
// échoue/est annulé/abandonné, elle redevient disponible (immédiatement au
// clic "annuler", ou automatiquement après 30 min via le balayage paresseux
// plus haut). Le paiement encaisse 100% sur le compte PayPal du jeu ; au
// paiement confirmé, 90% est crédité au solde interne du vendeur (retirable
// ensuite vers son propre PayPal), les 10% de commission restent sur le
// compte PayPal du jeu.
app.post('/api/astrocomptoir/cards/:code/buy', authMiddleware, async (req, res) => {
  try {
    if (!hasAcceptedAgreement(req.user.id)) {
      return res.status(403).json({ ok: false, error: 'agreement_required' });
    }
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    qSweepExpiredListingReservations.run();
    const code = String(req.params.code || '');
    const listing = qBestListingForCode.get(code, req.user.id);
    if (!listing) {
      return res.status(404).json({ ok: false, error: 'no_listing_available' });
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const order = await paypalCreateOrder(
      listing.price_cents / 100,
      `${origin}/astrocomptoir.html?buy=return`,
      `${origin}/astrocomptoir.html?buy=cancel`,
      `${cardCatalogName(listing.code)} — Astrocomptoir A'rms`,
      "A'rms — Astrocomptoir"
    );
    const reserved = qReserveListingForCheckout.run(order.id, listing.id);
    if (reserved.changes === 0) {
      // Vendue/réservée entre-temps (cas extrêmement rare) : la commande
      // PayPal créée ne sera jamais confirmée côté jeu, et tant que le
      // joueur ne paie pas réellement, aucune charge n'a lieu.
      return res.status(409).json({ ok: false, error: 'already_sold' });
    }
    const approveLink = (order.links || []).find(l => l.rel === 'approve');
    res.json({ ok: true, orderId: order.id, approveUrl: approveLink ? approveLink.href : null });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

app.post('/api/astrocomptoir/cards/confirm-purchase', authMiddleware, async (req, res) => {
  try {
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    const orderId = String(req.body?.orderId || '');
    const listing = qListingByPaypalOrderId.get(orderId);
    if (!listing) return res.status(404).json({ ok: false, error: 'purchase_not_found' });
    if (listing.status === 'sold') {
      if (listing.buyer_id !== req.user.id) return res.status(403).json({ ok: false, error: 'not_your_purchase' });
      return res.json({ ok: true, alreadyCompleted: true, code: listing.code, priceCents: listing.price_cents });
    }
    if (listing.status !== 'pending') {
      return res.status(409).json({ ok: false, error: 'listing_not_pending' });
    }
    const capture = await paypalCaptureOrder(orderId);
    if (capture.status !== 'COMPLETED') {
      return res.status(402).json({ ok: false, error: 'capture_not_completed' });
    }
    const marked = qMarkListingSoldFromPending.run(req.user.id, listing.id);
    if (marked.changes === 0) {
      return res.status(409).json({ ok: false, error: 'already_sold' });
    }
    // Répartition sur le montant NET réellement encaissé (après frais
    // PayPal), pas sur le prix affiché — voir extractNetAmountCents.
    const netCents = extractNetAmountCents(capture, listing.price_cents);
    const commission = Math.round(netCents * ASTRO_COMMISSION_RATE);
    const sellerGain = netCents - commission;
    qAddRealBalance.run(sellerGain, listing.seller_id);
    qUpsertCard.run(req.user.id, listing.code, 1);
    // price_cents reste le prix affiché/payé par l'acheteur (pour l'historique
    // et l'affichage) ; commission_cents reflète ce que le site garde vraiment ;
    // seller_gain_cents est le montant EXACT crédité au vendeur (net des frais
    // PayPal ET de la commission) — c'est ce champ, et lui seul, qui doit être
    // affiché au vendeur comme "reçu" dans son historique.
    qInsertTransaction.run(listing.id, listing.seller_id, req.user.id, listing.code, listing.price_cents, commission, sellerGain);
    res.json({ ok: true, code: listing.code, priceCents: listing.price_cents });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

// Libère une réservation dès le retour "annulé" de PayPal, pour que la
// carte redevienne achetable tout de suite plutôt que d'attendre le
// balayage automatique (30 min).
app.post('/api/astrocomptoir/cards/release-reservation', authMiddleware, (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '');
    const listing = qListingByPaypalOrderId.get(orderId);
    if (listing && listing.status === 'pending') {
      qReleaseListingReservation.run(listing.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/astrocomptoir/transactions', authMiddleware, (req, res) => {
  try {
    const rows = qMyTransactions.all(req.user.id, req.user.id);
    const transactions = rows.map(r => ({
      id: r.id, code: r.code, priceCents: r.price_cents, commissionCents: r.commission_cents,
      // Montant réellement crédité au vendeur (net des frais PayPal + commission).
      // NULL sur les transactions antérieures à cette colonne : on retombe alors
      // sur l'ancienne approximation (prix - commission), la seule donnée
      // disponible pour ces lignes historiques.
      sellerGainCents: (r.seller_gain_cents !== null && r.seller_gain_cents !== undefined)
        ? r.seller_gain_cents
        : (r.price_cents - r.commission_cents),
      role: r.seller_id === req.user.id ? 'sale' : 'purchase',
      counterparty: r.seller_id === req.user.id ? r.buyer_name : r.seller_name,
      createdAt: r.created_at,
    }));
    res.json({ ok: true, transactions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Recharge du portefeuille via PayPal Checkout (Orders API v2) ---
app.post('/api/astrocomptoir/topup/create-order', authMiddleware, async (req, res) => {
  try {
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    const amountCents = Math.round(Number(req.body?.amountCents));
    if (!Number.isFinite(amountCents) || amountCents < ASTRO_MIN_TOPUP_CENTS || amountCents > ASTRO_MAX_TOPUP_CENTS) {
      return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const order = await paypalCreateOrder(
      amountCents / 100,
      `${origin}/astrocomptoir.html?topup=return`,
      `${origin}/astrocomptoir.html?topup=cancel`
    );
    qInsertTopup.run(req.user.id, amountCents, order.id, 'pending');
    const approveLink = (order.links || []).find(l => l.rel === 'approve');
    res.json({ ok: true, orderId: order.id, approveUrl: approveLink ? approveLink.href : null });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

app.post('/api/astrocomptoir/topup/capture', authMiddleware, async (req, res) => {
  try {
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    const orderId = String(req.body?.orderId || '');
    const topup = qTopupByOrderId.get(orderId);
    if (!topup || topup.user_id !== req.user.id) {
      return res.status(404).json({ ok: false, error: 'topup_not_found' });
    }
    if (topup.status === 'completed') {
      const wallet = qGetWallet.get(req.user.id);
      return res.json({ ok: true, balanceCents: wallet.real_balance_cents, alreadyCompleted: true });
    }
    const capture = await paypalCaptureOrder(orderId);
    if (capture.status !== 'COMPLETED') {
      return res.status(402).json({ ok: false, error: 'capture_not_completed' });
    }
    qCompleteTopup.run(topup.id);
    qAddRealBalance.run(topup.amount_cents, req.user.id);
    const wallet = qGetWallet.get(req.user.id);
    res.json({ ok: true, balanceCents: wallet.real_balance_cents });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

// ===================================================================
// BOUTIQUE — achat de lots de pièces contre argent réel (PayPal Checkout,
// même mécanique que la recharge du portefeuille Astrocomptoir ci-dessus :
// create-order ouvre une commande PayPal pour le prix exact du lot,
// capture la valide et crédite les pièces UNE SEULE FOIS — jamais deux
// fois pour la même commande PayPal, voir le statut 'completed').
// ===================================================================
app.get('/api/shop/coin-packs', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    paypalConfigured: isPaypalConfigured(),
    stripeConfigured: isStripeConfigured(),
    packs: COIN_PACKS.map(p => ({ id: p.id, coins: p.coins, amountCents: p.amountCents, label: p.label, icon: p.icon, bonusPct: p.bonusPct })),
  });
});

app.post('/api/shop/coins/create-order', authMiddleware, async (req, res) => {
  try {
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    const pack = getCoinPack(String(req.body?.packId || ''));
    if (!pack) return res.status(400).json({ ok: false, error: 'invalid_pack' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const order = await paypalCreateOrder(
      pack.amountCents / 100,
      `${origin}/boutique.html?coins=return`,
      `${origin}/boutique.html?coins=cancel`,
      `Lot "${pack.label}" (${pack.coins} pièces) — Boutique A'rms`,
      "A'rms — Boutique"
    );
    qInsertCoinPurchase.run(req.user.id, pack.id, pack.coins, pack.amountCents, order.id, 'pending');
    const approveLink = (order.links || []).find(l => l.rel === 'approve');
    res.json({ ok: true, orderId: order.id, approveUrl: approveLink ? approveLink.href : null });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

app.post('/api/shop/coins/capture', authMiddleware, async (req, res) => {
  try {
    if (!isPaypalConfigured()) return res.status(503).json({ ok: false, error: 'paypal_not_configured' });
    const orderId = String(req.body?.orderId || '');
    const purchase = qCoinPurchaseByOrderId.get(orderId);
    if (!purchase || purchase.user_id !== req.user.id) {
      return res.status(404).json({ ok: false, error: 'purchase_not_found' });
    }
    if (purchase.status === 'completed') {
      const coins = coinsForResponse(req);
      return res.json({ ok: true, coins, coinsGained: purchase.coins, alreadyCompleted: true });
    }
    const capture = await paypalCaptureOrder(orderId);
    if (capture.status !== 'COMPLETED') {
      return res.status(402).json({ ok: false, error: 'capture_not_completed' });
    }
    qCompleteCoinPurchase.run(purchase.id);
    qAddCoins.run(purchase.coins, req.user.id);
    const coins = coinsForResponse(req);
    res.json({ ok: true, coins, coinsGained: purchase.coins });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'paypal_error' });
  }
});

// --- Paiement direct par carte bancaire (Stripe Checkout) — même principe
// que le flux PayPal ci-dessus : create-checkout ouvre une session de
// paiement Stripe pour le prix exact du lot, confirm-stripe la vérifie et
// crédite les pièces UNE SEULE FOIS (idem, jamais deux fois pour la même
// session, voir le statut 'completed'). L'argent part directement vers le
// compte bancaire relié au compte Stripe configuré (STRIPE_SECRET_KEY).
app.post('/api/shop/coins/create-checkout', authMiddleware, async (req, res) => {
  try {
    if (!isStripeConfigured()) return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
    const pack = getCoinPack(String(req.body?.packId || ''));
    if (!pack) return res.status(400).json({ ok: false, error: 'invalid_pack' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripeCreateCheckoutSession(
      pack.amountCents,
      `${pack.label} — ${pack.coins} pièces (A'rms)`,
      `${origin}/boutique.html?coins=stripe_return&session_id={CHECKOUT_SESSION_ID}`,
      `${origin}/boutique.html?coins=stripe_cancel`,
      `${origin}/assets/${pack.icon || 'monnaie.png'}`
    );
    qInsertCoinPurchaseStripe.run(req.user.id, pack.id, pack.coins, pack.amountCents, session.id, 'pending');
    res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'stripe_error' });
  }
});

app.post('/api/shop/coins/confirm-stripe', authMiddleware, async (req, res) => {
  try {
    if (!isStripeConfigured()) return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
    const sessionId = String(req.body?.sessionId || '');
    const purchase = qCoinPurchaseByStripeSession.get(sessionId);
    if (!purchase || purchase.user_id !== req.user.id) {
      return res.status(404).json({ ok: false, error: 'purchase_not_found' });
    }
    if (purchase.status === 'completed') {
      const coins = coinsForResponse(req);
      return res.json({ ok: true, coins, coinsGained: purchase.coins, alreadyCompleted: true });
    }
    const session = await stripeRetrieveSession(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ ok: false, error: 'payment_not_completed' });
    }
    qCompleteCoinPurchase.run(purchase.id);
    qAddCoins.run(purchase.coins, req.user.id);
    const coins = coinsForResponse(req);
    res.json({ ok: true, coins, coinsGained: purchase.coins });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: 'stripe_error' });
  }
});

app.get('/api/astrocomptoir/withdrawals', authMiddleware, (req, res) => {
  try {
    const rows = qMyWithdrawals.all(req.user.id);
    res.json({
      ok: true,
      withdrawals: rows.map(r => ({
        id: r.id, amountCents: r.amount_cents, status: r.status, requestedAt: r.requested_at, processedAt: r.processed_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Administration des retraits (confirmation manuelle) ---
// L'administrateur envoie l'argent lui-même, à la main, depuis son propre
// compte PayPal (Loris.croce2@gmail.com) vers l'adresse PayPal du joueur
// (w.paypal_email, affichée dans le panneau). Ce bouton ne fait qu'ENREGISTRER
// que l'envoi a bien eu lieu — il n'appelle plus l'API PayPal Payouts
// (bloquée côté PayPal, AUTHORIZATION_ERROR, en attente de validation de
// leur part), pour que les retraits fonctionnent dès maintenant sans en
// dépendre.
app.get('/api/admin/astrocomptoir/withdrawals', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const rows = qPendingWithdrawals.all();
    res.json({
      ok: true,
      withdrawals: rows.map(r => ({
        id: r.id, amountCents: r.amount_cents, paypalEmail: r.paypal_email,
        userName: r.user_name, userEmail: r.user_email, requestedAt: r.requested_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/astrocomptoir/withdrawals/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const w = qWithdrawalById.get(id);
    if (!w || w.status !== 'pending') return res.status(404).json({ ok: false, error: 'withdrawal_not_found' });
    qMarkWithdrawalPaid.run(null, id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/astrocomptoir/withdrawals/:id/reject', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const w = qWithdrawalById.get(id);
    if (!w || w.status !== 'pending') return res.status(404).json({ ok: false, error: 'withdrawal_not_found' });
    qAddRealBalance.run(w.amount_cents, w.user_id); // remboursement intégral
    qMarkWithdrawalRejected.run(String(req.body?.reason || ''), id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Remise à zéro de l'historique des ventes (admin uniquement) ---
// Efface définitivement toutes les lignes de market_transactions (ventes
// conclues, tous joueurs confondus) — n'affecte NI les soldes des joueurs
// (déjà crédités/débités au moment de chaque vente, ce reset ne les touche
// pas), NI les annonces actives (market_listings), NI les demandes de
// retrait. Sert uniquement à vider l'affichage de l'historique général et
// des historiques personnels des joueurs.
app.post('/api/admin/astrocomptoir/reset-history', authMiddleware, adminMiddleware, (req, res) => {
  try {
    qResetMarketTransactions.run();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
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
    socket.data.matchId = matchId;
    socket.data.seat = seat;
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
    const matchId = socket.data.matchId;
    const seat = socket.data.seat;
    if (!matchId || !seat) return;
    const st = liveMatches.get(matchId);
    if (!st) return;
    // Si une reconnexion plus récente a déjà pris le relais sur ce siège
    // (nouvel onglet, refresh...), ce socket-ci n'a plus rien à faire ici.
    if (st.sockets[seat] !== socket.id) return;

    // Déconnexion = défaite immédiate. Pas de délai de grâce, pas de
    // reconnexion possible : l'autre joueur remporte la partie sur-le-champ.
    const otherSeat = (seat === 'bottom') ? 'top' : 'bottom';
    io.to(matchId).emit('matchForfeit', { winnerSeat: otherSeat, loserSeat: seat });
    liveMatches.delete(matchId);
  });
});

// ===================================================================
// TCHAT GLOBAL (temps réel) — espace de noms séparé du jeu 1v1 ci-dessus,
// authentifié via le même cookie JWT que le reste du site (arms_token).
// Un joueur peut avoir plusieurs onglets ouverts à la fois : on garde donc
// un Set de socket ids par utilisateur plutôt qu'un seul socket.
// ===================================================================
const chatNsp = io.of('/chat');
const chatOnlineSockets = new Map(); // userId -> Set<socketId>

function isUserOnline(userId) {
  const set = chatOnlineSockets.get(userId);
  return !!set && set.size > 0;
}

// Envoie un événement à tous les onglets ouverts d'un joueur donné, s'il en
// a (sinon ne fait rien — il verra l'info au prochain chargement de page,
// via les routes REST /api/chat/friends etc.).
function notifyUser(userId, event, payload) {
  chatNsp.to(`user:${userId}`).emit(event, payload);
}

// Récupère le cookie arms_token brut depuis l'en-tête Cookie de la requête
// de handshake socket.io (le cookie est httpOnly : pas de cookie-parser
// disponible ici, socket.io ne passe pas par les middlewares Express).
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map(p => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

chatNsp.use((socket, next) => {
  try {
    const token = parseCookie(socket.request.headers.cookie, 'arms_token');
    if (!token) return next(new Error('non_auth'));
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.userId = decoded.id;
    socket.data.name = decoded.name;
    next();
  } catch (e) {
    next(new Error('token_invalid'));
  }
});

chatNsp.on('connection', (socket) => {
  const userId = socket.data.userId;
  socket.join('general');
  socket.join(`user:${userId}`);
  if (!chatOnlineSockets.has(userId)) chatOnlineSockets.set(userId, new Set());
  chatOnlineSockets.get(userId).add(socket.id);

  socket.on('chat:sendGeneral', (payload) => {
    try {
      const text = String(payload?.text || '').trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      const info = qInsertGeneralMessage.run(userId, text);
      const u = qUserBasic.get(userId);
      const profile = qGetProfile.get(userId);
      chatNsp.to('general').emit('chat:general', {
        id: info.lastInsertRowid, userId, name: u.name, avatar: u.avatar || '',
        color: (profile && profile.chat_color) || '#7df9ff', text, createdAt: new Date().toISOString(),
      });
    } catch (e) { console.error(e); }
  });

  socket.on('chat:sendPrivate', (payload) => {
    try {
      const toId = parseInt(payload?.toId, 10);
      const text = String(payload?.text || '').trim().slice(0, CHAT_MAX_LEN);
      if (!text || !Number.isFinite(toId) || toId === userId) return;
      if (!areFriends(userId, toId)) {
        socket.emit('chat:privateError', { error: 'not_friends' });
        return;
      }
      const info = qInsertPrivateMessage.run(userId, toId, text);
      const u = qUserBasic.get(userId);
      const profile = qGetProfile.get(userId);
      const message = {
        id: info.lastInsertRowid, fromId: userId, toId, name: u.name, avatar: u.avatar || '',
        color: (profile && profile.chat_color) || '#7df9ff', text, createdAt: new Date().toISOString(),
      };
      chatNsp.to(`user:${toId}`).emit('chat:private', message);
      chatNsp.to(`user:${userId}`).emit('chat:private', message);
    } catch (e) { console.error(e); }
  });

  socket.on('disconnect', () => {
    const set = chatOnlineSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) chatOnlineSockets.delete(userId);
    }
  });
});

// ===================================================================
// Régénération automatique de public/data/card-stats.json — évite que ce
// fichier ne devienne obsolète à chaque nouvelle carte ajoutée au jeu. Il
// est entièrement reconstruit à CHAQUE démarrage du serveur (donc à chaque
// déploiement), directement à partir des vraies tables de données du jeu
// (CARD_TYPES / CARD_HP_BASE / CARD_SHIELD_BASE dans public/index.html),
// croisées avec la liste officielle des cartes implémentées (ALL_CARDS
// dans cards-catalog.js). Plus jamais besoin de le régénérer à la main :
// il suffit d'ajouter une carte normalement (dans index.html ET
// cards-catalog.js, comme d'habitude) et le prochain déploiement s'occupe
// du reste automatiquement.
// ===================================================================
function regenerateCardStats() {
  try {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');

    function extractTable(varName) {
      const startIdx = html.indexOf(`const ${varName}`);
      if (startIdx === -1) return {};
      const braceStart = html.indexOf('{', startIdx);
      let depth = 0, i = braceStart;
      while (i < html.length) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      const body = html.slice(braceStart + 1, i);
      const pairs = {};
      // [CTW] : C = cartes numériques classiques, T = jetons, W = cartes
      // Saison (récompenses de fin de saison, ex. W0001 Zwav ↔ label 'W1').
      const re = /'([CTW]\d+)'\s*:\s*(-?\d+|'[^']*'|"[^"]*")/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        let val = m[2];
        if (val.startsWith("'") || val.startsWith('"')) val = val.slice(1, -1);
        else val = parseInt(val, 10);
        pairs[m[1]] = val;
      }
      return pairs;
    }

    const cardTypes = extractTable('CARD_TYPES');
    const cardHp = extractTable('CARD_HP_BASE');
    const cardShield = extractTable('CARD_SHIELD_BASE');
    const cardNames = extractTable('CARD_NAMES');

    const result = {};
    catalog.ALL_CARDS.forEach(({ num, code }) => {
      const label = `C${num}`;
      if (cardTypes[label] !== 'personnage') return;
      result[code] = {
        type: 'personnage',
        hp: cardHp[label] || 0,
        shield: cardShield[label] || 0,
      };
    });
    // SAISON : mêmes tables (CARD_TYPES/CARD_HP_BASE/CARD_SHIELD_BASE),
    // simplement avec le label 'W{num}' au lieu de 'C{num}' — voir
    // catalog.SEASON_CARDS, volontairement hors de ALL_CARDS pour rester
    // exclues des boosters/de la boutique.
    (catalog.SEASON_CARDS || []).forEach(({ num, code }) => {
      const label = `W${num}`;
      if (cardTypes[label] !== 'personnage') return;
      result[code] = {
        type: 'personnage',
        hp: cardHp[label] || 0,
        shield: cardShield[label] || 0,
      };
    });

    const outPath = path.join(__dirname, 'public', 'data', 'card-stats.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result), 'utf-8');
    console.log(`[card-stats] Régénéré automatiquement au démarrage : ${Object.keys(result).length} cartes personnage.`);

    // --- Catalogue nom/type/faction pour TOUTES les cartes (Astrocomptoir) ---
    // Fichier volontairement SÉPARÉ de card-stats.json : ce dernier alimente
    // directement le moteur de jeu (CARD_STATS côté client, voir
    // getStatsForLabel dans index.html) — y ajouter des champs ou des entrées
    // pour les cartes non-personnage risquerait d'interférer avec la partie
    // en cours. card-catalog.json, lui, ne sert QUE à l'affichage (recherche/
    // filtres de l'Astrocomptoir) et ne touche jamais au gameplay.
    const catalogResult = {};
    catalog.ALL_CARDS.forEach(({ num, code }) => {
      const label = `C${num}`;
      catalogResult[code] = {
        name: cardNames[label] || `Carte ${code}`,
        type: cardTypes[label] || 'inconnu',
        faction: catalog.factionOf(num),
      };
    });
    // SAISON : mêmes tables, label 'W{num}' — la faction vient directement
    // de catalog.SEASON_CARDS (factionOf(num) ne connaît que le schéma
    // numérique 1-250 et donnerait un résultat faux pour ces codes).
    (catalog.SEASON_CARDS || []).forEach(({ num, code, faction, requiredRankIndex }) => {
      const label = `W${num}`;
      catalogResult[code] = {
        name: cardNames[label] || `Carte ${code}`,
        type: cardTypes[label] || 'inconnu',
        faction: faction,
        // Index (0-14) du rang de Menace requis pour cette carte — utilisé
        // par classement.html pour l'afficher (grisée, cadenas) à côté du
        // bon rang sur la Voie de la Menace.
        requiredRankIndex: typeof requiredRankIndex === 'number' ? requiredRankIndex : null,
      };
    });
    const catalogOutPath = path.join(__dirname, 'public', 'data', 'card-catalog.json');
    fs.writeFileSync(catalogOutPath, JSON.stringify(catalogResult), 'utf-8');
    console.log(`[card-catalog] Régénéré automatiquement au démarrage : ${Object.keys(catalogResult).length} cartes.`);
  } catch (err) {
    // En cas d'échec (fichier index.html introuvable, format inattendu...),
    // on ne bloque JAMAIS le démarrage du serveur pour autant — le fichier
    // existant (s'il y en a un) reste simplement en place tel quel.
    console.error('[card-stats] Échec de la régénération automatique — le fichier existant reste inchangé :', err.message);
  }
}
regenerateCardStats();
ensureAdminFullCollection();

// ===================================================================
// SIGNALEMENT DE BUG — onglet "🐛 Signaler un bug" de la box de Tchat, en
// partie : texte + captures d'écran, envoyés par e-mail. Fonctionne
// uniquement si SMTP_HOST/SMTP_USER/SMTP_PASS sont renseignés dans .env
// (voir .env.example) — sans ça, la route répond 'mail_not_configured'
// plutôt que de planter, exactement comme le PayPal ci-dessus tant qu'il
// n'est pas configuré.
// ===================================================================
const multer = require('multer');
const nodemailer = require('nodemailer');

const BUG_REPORT_EMAIL = process.env.BUG_REPORT_EMAIL || 'loris.croce2@gmail.com';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
function isMailConfigured() { return !!(SMTP_HOST && SMTP_USER && SMTP_PASS); }
let mailTransporter = null;
function getMailTransporter() {
  if (!isMailConfigured()) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // true = SSL direct (port 465), false = STARTTLS (port 587)
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return mailTransporter;
}

// Vérification non-bloquante au démarrage : confirme dans les logs serveur
// que les identifiants SMTP sont valides et la connexion possible, sans
// attendre le premier signalement réel pour le découvrir.
if (isMailConfigured()) {
  getMailTransporter().verify((err) => {
    if (err) console.error('[report-bug] Config SMTP invalide, l\'envoi échouera :', err.message);
    else console.log(`[report-bug] SMTP prêt (${SMTP_USER} → ${BUG_REPORT_EMAIL || 'loris.croce2@gmail.com'}).`);
  });
} else {
  console.log('[report-bug] SMTP non configuré (.env) — le formulaire de signalement restera inactif.');
}

// Stockage en mémoire (jamais écrit sur disque) : les pièces jointes ne
// servent qu'à être attachées à l'e-mail sortant, puis sont jetées.
const bugReportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 }, // 8 Mo par fichier, 5 fichiers max
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)), // captures d'écran uniquement
});

app.post('/api/report-bug', bugReportUpload.array('screenshots', 5), async (req, res) => {
  try {
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'message_required' });

    // Identité du joueur si connecté — purement informatif, jamais requis :
    // un joueur non connecté doit pouvoir signaler un bug lui aussi (pas de
    // authMiddleware sur cette route).
    let reporter = 'Joueur non connecté';
    try {
      const token = req.cookies?.arms_token;
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        reporter = `${decoded.name} <${decoded.email}>`;
      }
    } catch (e) { /* jeton absent/invalide : on garde "Joueur non connecté" */ }

    if (!isMailConfigured()) {
      console.warn(`[report-bug] Signalement reçu mais SMTP non configuré (voir .env.example) — non envoyé. De : ${reporter}. Message : ${message.slice(0, 200)}`);
      return res.status(503).json({ ok: false, error: 'mail_not_configured' });
    }

    const transporter = getMailTransporter();
    const attachments = (req.files || []).map((f, i) => ({
      filename: f.originalname || `capture-${i + 1}.png`,
      content: f.buffer,
      contentType: f.mimetype,
    }));

    await transporter.sendMail({
      from: SMTP_USER,
      to: BUG_REPORT_EMAIL,
      replyTo: SMTP_USER,
      subject: `[A'rms] Signalement de bug — ${reporter}`,
      text: `Signalé par : ${reporter}\nPage : ${req.body?.pageUrl || 'inconnue'}\nNavigateur : ${req.body?.userAgent || 'inconnu'}\nDate : ${new Date().toISOString()}\n\n${message}`,
      attachments,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[report-bug] Échec de l\'envoi :', err);
    res.status(500).json({ ok: false, error: 'send_failed' });
  }
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
