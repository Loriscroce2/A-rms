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
    status TEXT NOT NULL DEFAULT 'active', -- active | pending | sold | cancelled
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT,
    buyer_id INTEGER,
    stripe_session_id TEXT, -- (hérité) réservation pendant un paiement Stripe — non utilisé actuellement
    paypal_order_id TEXT,   -- réservation en cours pendant un paiement PayPal
    reserved_until TEXT,    -- expiration de la réservation (libère l'annonce si abandonnée)
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

  -- ===================================================================
  -- BOUTIQUE — achat de LOTS DE PIÈCES (coins, monnaie de jeu) contre de
  -- l'argent réel via PayPal. Totalement distinct de l'Astrocomptoir
  -- (real_balance_cents) : ici l'argent réel est définitivement encaissé
  -- par l'éditeur du jeu en échange d'une quantité fixe de coins créditée
  -- sur le compte (pas de portefeuille revendable, pas de retrait). Même
  -- schéma "pending → completed" que wallet_topups, pour la même raison
  -- (ne jamais créditer deux fois le même paiement PayPal).
  -- ===================================================================
  CREATE TABLE IF NOT EXISTS coin_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pack_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    paypal_order_id TEXT,
    provider TEXT NOT NULL DEFAULT 'paypal', -- 'paypal' | 'stripe'
    stripe_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- ===================================================================
  -- TCHAT GLOBAL — un tchat général visible de tous + des tchats privés
  -- entre amis. Distinct du tchat de partie (qui vit en mémoire côté
  -- socket.io pendant un match 1v1) : ici tout est persisté en base pour
  -- garder l'historique entre deux visites.
  -- ===================================================================

  -- Relation d'amitié entre deux joueurs. Une seule ligne par paire, créée
  -- par le "demandeur" (requester_id) ; reste 'pending' tant que le
  -- destinataire (addressee_id) n'a pas répondu. Le tchat privé n'est
  -- accessible qu'une fois status = 'accepted'.
  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    addressee_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT,
    UNIQUE(requester_id, addressee_id),
    FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (addressee_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- Tchat général : tout le monde voit tout, aucune notion de destinataire.
  CREATE TABLE IF NOT EXISTS chat_general_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- Tchat privé entre deux amis. read_at reste NULL tant que le
  -- destinataire n'a pas ouvert la conversation (sert au badge "non lu").
  CREATE TABLE IF NOT EXISTS chat_private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT,
    FOREIGN KEY (from_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES users (id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships (requester_id, status);
  CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships (addressee_id, status);
  CREATE INDEX IF NOT EXISTS idx_chat_private_pair ON chat_private_messages (from_id, to_id);
  CREATE INDEX IF NOT EXISTS idx_chat_private_pair_rev ON chat_private_messages (to_id, from_id);

  -- Trace chaque carte 'W' (récompense de fin de saison, voir SEASON_CARDS
  -- dans cards-catalog.js) déjà distribuée à un joueur via le bouton admin
  -- "débloquer toutes les cartes", pour ne JAMAIS la distribuer deux fois au
  -- même joueur si l'administrateur clique le bouton plusieurs fois (ex.
  -- après que d'autres joueurs ont depuis atteint le rang requis).
  CREATE TABLE IF NOT EXISTS season_card_grants (
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, code),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );
`);

// Migration douce pour les bases coin_purchases créées avant l'ajout du
// paiement par carte (Stripe) : on ajoute les deux colonnes manquantes sans
// toucher aux achats déjà enregistrés (tous restent 'paypal' par défaut).
const coinPurchaseCols = db.prepare("PRAGMA table_info(coin_purchases)").all().map(c => c.name);
if (!coinPurchaseCols.includes('provider')) {
  db.exec("ALTER TABLE coin_purchases ADD COLUMN provider TEXT NOT NULL DEFAULT 'paypal'");
}
if (!coinPurchaseCols.includes('stripe_session_id')) {
  db.exec('ALTER TABLE coin_purchases ADD COLUMN stripe_session_id TEXT');
}

// Migration douce : colonne seller_gain_cents sur market_transactions — le
// montant RÉELLEMENT crédité au vendeur (après frais PayPal ET commission),
// distinct de price_cents (prix affiché/payé par l'acheteur, brut) et
// commission_cents (part gardée par le site). Sans cette colonne dédiée,
// l'historique ne pouvait afficher qu'une approximation trompeuse
// (price_cents - commission_cents), qui ignore les frais PayPal déjà
// déduits en amont — voir extractNetAmountCents côté server.js. NULL sur les
// lignes déjà existantes (avant cette migration) : le montant exact n'a pas
// été conservé pour elles, l'affichage retombe alors sur l'ancienne
// approximation pour ces seules anciennes lignes.
const marketTransactionCols = db.prepare("PRAGMA table_info(market_transactions)").all().map(c => c.name);
if (!marketTransactionCols.includes('seller_gain_cents')) {
  db.exec('ALTER TABLE market_transactions ADD COLUMN seller_gain_cents INTEGER');
}

// Migration douce pour les bases market_listings créées avant l'achat direct
// par carte bancaire (réservation le temps du paiement Stripe).
const marketListingCols = db.prepare("PRAGMA table_info(market_listings)").all().map(c => c.name);
if (!marketListingCols.includes('stripe_session_id')) {
  db.exec('ALTER TABLE market_listings ADD COLUMN stripe_session_id TEXT');
}
if (!marketListingCols.includes('paypal_order_id')) {
  db.exec('ALTER TABLE market_listings ADD COLUMN paypal_order_id TEXT');
}
if (!marketListingCols.includes('reserved_until')) {
  db.exec('ALTER TABLE market_listings ADD COLUMN reserved_until TEXT');
}

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
// STRIPE CONNECT : compte Stripe Express propre à chaque vendeur, pour
// recevoir automatiquement sa part de chaque vente (90%) et retirer vers
// son propre IBAN — remplace le paiement PayPal manuel pour les retraits.
// stripe_connect_ready = 1 une fois l'onboarding Stripe terminé côté
// vendeur (identité + IBAN vérifiés, payouts_enabled = true côté Stripe).
if (!userCols.includes('stripe_connect_account_id')) {
  db.exec("ALTER TABLE users ADD COLUMN stripe_connect_account_id TEXT NOT NULL DEFAULT ''");
}
if (!userCols.includes('stripe_connect_ready')) {
  db.exec('ALTER TABLE users ADD COLUMN stripe_connect_ready INTEGER NOT NULL DEFAULT 0');
}
// TCHAT : couleur de police choisie par le joueur pour ses messages
// (général + privés), au format hexadécimal CSS (#rrggbb).
if (!userCols.includes('chat_color')) {
  db.exec("ALTER TABLE users ADD COLUMN chat_color TEXT NOT NULL DEFAULT '#7df9ff'");
}

// PSEUDOS UNIQUES (insensible à la casse) — nécessaire pour que l'ajout
// d'ami par pseudo dans le tchat soit toujours sans ambiguïté. Comme des
// comptes existants ont pu être créés avant cette règle, on commence par
// renommer les doublons hérités (le compte le plus ancien garde son
// pseudo tel quel, les suivants reçoivent un suffixe " (2)", " (3)"...),
// puis on verrouille l'unicité au niveau de la base pour la suite. Cette
// vérification est sans effet (rapide) une fois qu'il n'y a plus aucun
// doublon, donc on peut la laisser tourner à chaque démarrage.
const duplicateNameGroups = db.prepare(`
  SELECT LOWER(name) AS lname, COUNT(*) AS n FROM users GROUP BY LOWER(name) HAVING COUNT(*) > 1
`).all();
if (duplicateNameGroups.length > 0) {
  const qUsersWithName = db.prepare('SELECT id, name FROM users WHERE LOWER(name) = ? ORDER BY created_at ASC, id ASC');
  const qNameTaken = db.prepare('SELECT 1 FROM users WHERE LOWER(name) = LOWER(?)');
  const qRenameUser = db.prepare('UPDATE users SET name = ? WHERE id = ?');
  for (const group of duplicateNameGroups) {
    const rows = qUsersWithName.all(group.lname);
    // Le premier (compte le plus ancien) garde son pseudo inchangé.
    for (let i = 1; i < rows.length; i++) {
      let suffix = i + 1;
      let candidate = `${rows[i].name} (${suffix})`;
      while (qNameTaken.get(candidate)) { suffix++; candidate = `${rows[i].name} (${suffix})`; }
      qRenameUser.run(candidate, rows[i].id);
      console.log(`[migration] Pseudo en double renommé : "${rows[i].name}" (id ${rows[i].id}) -> "${candidate}"`);
    }
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_nocase ON users (name COLLATE NOCASE)');

module.exports = db;
