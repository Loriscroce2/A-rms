// ===================================================================
// db.js — Connexion à la base de données SQLite (remplace MongoDB)
// ===================================================================
// SQLite stocke tout dans un seul fichier (arms.db). Pas de service
// externe, pas de mot de passe à gérer, rien à installer à part le
// paquet npm "better-sqlite3".

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// En local : arms.db à côté de ce fichier, comme avant.
// En hébergement (Railway) : on pointera DB_PATH vers le disque persistant
// (ex: /data/arms.db) via une variable d'environnement, pour que la base
// survive aux redéploiements.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'arms.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// --- Diagnostic de démarrage : permet de vérifier en un coup d'œil dans les
// logs Railway si la base est bien stockée sur le disque permanent, et si
// elle existait déjà avant ce démarrage (donc pas réinitialisée à chaque déploi).
console.log('[db] Variable DB_PATH :', process.env.DB_PATH || '(non définie — utilise le chemin local par défaut)');
console.log('[db] Chemin réellement utilisé :', dbPath);
if (fs.existsSync(dbPath)) {
  const stats = fs.statSync(dbPath);
  console.log(`[db] ✔ Fichier déjà existant, ${stats.size} octets — la base est bien persistante.`);
} else {
  console.log('[db] ⚠ Aucun fichier trouvé à cet emplacement — nouvelle base vide créée maintenant.');
}

const db = new Database(dbPath);
console.log(`[db] Base de données ouverte : ${dbPath}`);

// Active les clés étrangères (pour que ON DELETE CASCADE fonctionne)
db.pragma('foreign_keys = ON');

// --- Création des tables si elles n'existent pas déjà ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    coins INTEGER NOT NULL DEFAULT 0,
    avatar TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    cards TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_cards (
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, code),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS match_rewards (
    user_id INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    PRIMARY KEY (user_id, match_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shop_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hour_bucket INTEGER NOT NULL,
    slots TEXT NOT NULL
  );

  -- Suivi des achats de la boutique horaire PAR JOUEUR : chaque joueur peut
  -- acheter chaque emplacement une seule fois par heure (hour_bucket), et
  -- l'achat d'un joueur n'empêche jamais un autre joueur d'acheter le même
  -- emplacement (contrairement à l'ancien système où "sold" était global).
  CREATE TABLE IF NOT EXISTS shop_purchases (
    user_id INTEGER NOT NULL,
    hour_bucket INTEGER NOT NULL,
    slot_index INTEGER NOT NULL,
    PRIMARY KEY (user_id, hour_bucket, slot_index),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- ===================================================================
  -- ASTROCOMPTOIR — hôtel de vente entre joueurs, contre argent réel.
  -- Le "portefeuille réel" (real_balance_cents, sur la table users, voir
  -- migration douce plus bas) est totalement séparé des "coins" (monnaie
  -- de jeu gratuite) : c'est de l'argent véritable, rechargé via PayPal et
  -- retirable vers PayPal, jamais gagnable en jouant.
  -- ===================================================================

  -- Une annonce = une carte mise en vente par un joueur, à un prix fixe
  -- (en centimes d'euro). La carte est retirée de sa collection dès la
  -- mise en vente (et lui est rendue si l'annonce est annulée), pour
  -- qu'il ne puisse jamais vendre deux fois le même exemplaire ni s'en
  -- servir en deck tant qu'il est en vente.
  CREATE TABLE IF NOT EXISTS market_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', -- active | sold | cancelled
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT,
    buyer_id INTEGER,
    FOREIGN KEY (seller_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- Historique immuable de chaque vente conclue (même si l'annonce ou les
  -- comptes sont ensuite supprimés) — sert de preuve/ledger pour la
  -- commission de 10% prélevée sur chaque transaction.
  CREATE TABLE IF NOT EXISTS market_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    buyer_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    commission_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Recharges du portefeuille réel via PayPal Checkout (Orders API v2).
  CREATE TABLE IF NOT EXISTS wallet_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    paypal_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- Demandes de retrait vers PayPal : débitées du solde dès la demande
  -- (pour ne jamais permettre un double retrait), puis validées
  -- manuellement par un administrateur avant l'envoi réel via PayPal
  -- Payouts (voir /api/admin/astrocomptoir/withdrawals/:id/approve).
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    paypal_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | rejected
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    paypal_payout_batch_id TEXT,
    admin_note TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );
`);

// Migration douce : si la base existait déjà avant l'ajout de "coins" (anciennes
// installations), on ajoute la colonne sans effacer les comptes existants.
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('coins')) {
  db.exec('ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('avatar')) {
  db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
}
// Système de classement "Menace" (parties classées) : points de menace +
// quelques statistiques affichées sur le profil/classement.
if (!userCols.includes('threat_points')) {
  db.exec('ALTER TABLE users ADD COLUMN threat_points INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('ranked_wins')) {
  db.exec('ALTER TABLE users ADD COLUMN ranked_wins INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('ranked_losses')) {
  db.exec('ALTER TABLE users ADD COLUMN ranked_losses INTEGER NOT NULL DEFAULT 0');
}
// Suivi du didacticiel : 0 = jamais vu (affiché automatiquement à la
// première connexion), 1 = déjà vu au moins une fois.
if (!userCols.includes('has_seen_tutorial')) {
  db.exec('ALTER TABLE users ADD COLUMN has_seen_tutorial INTEGER NOT NULL DEFAULT 0');
}
// ASTROCOMPTOIR : solde réel en centimes d'euro (argent véritable, distinct
// des "coins"), email PayPal enregistré pour les retraits, et trace de
// l'acceptation de l'accord légal (obligatoire avant tout achat/vente/retrait).
if (!userCols.includes('real_balance_cents')) {
  db.exec('ALTER TABLE users ADD COLUMN real_balance_cents INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('paypal_email')) {
  db.exec("ALTER TABLE users ADD COLUMN paypal_email TEXT NOT NULL DEFAULT ''");
}
if (!userCols.includes('astro_agreement_accepted_at')) {
  db.exec('ALTER TABLE users ADD COLUMN astro_agreement_accepted_at TEXT');
}
if (!userCols.includes('astro_agreement_version')) {
  db.exec('ALTER TABLE users ADD COLUMN astro_agreement_version TEXT');
}

module.exports = db;
