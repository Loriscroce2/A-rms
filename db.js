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

module.exports = db;
