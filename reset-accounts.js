// ===================================================================
// reset-accounts.js — Remet tous les comptes à zéro (collection, decks,
// pièces, récompenses) SANS supprimer les comptes eux-mêmes (email,
// mot de passe, pseudo restent inchangés — pas besoin de se réinscrire).
//
// Utilisation : depuis le dossier A-rms (celui qui contient server.js
// et db.js), le SERVEUR ARRÊTÉ (Ctrl+C d'abord), lancer :
//   node reset-accounts.js
// ===================================================================

const path = require('path');

console.log('Dossier courant :', process.cwd());
console.log('Chemin attendu de la base :', path.join(process.cwd(), 'arms.db'));
console.log('');

let db;
try {
  db = require('./db');
} catch (e) {
  console.error("❌ Impossible de charger db.js. Vérifie que tu lances bien cette commande");
  console.error("   DEPUIS LE DOSSIER A-rms (celui qui contient server.js, db.js et ce fichier).");
  console.error("   Détail de l'erreur :", e.message);
  process.exit(1);
}

const users = db.prepare('SELECT id, name, email, coins, avatar FROM users').all();
console.log(`${users.length} compte(s) trouvé(s) dans la base :`);
users.forEach(u => console.log(`  - ${u.name} (${u.email}) — actuellement ${u.coins} pièces, avatar: ${u.avatar ? '(personnalisé)' : '(par défaut)'}`));
console.log('');

if (users.length === 0) {
  console.log("Aucun compte trouvé — soit la base est neuve, soit ce n'est pas la bonne base de données.");
  process.exit(0);
}

const countCards = db.prepare('SELECT COUNT(*) as n FROM user_cards WHERE user_id = ?');
const delCards = db.prepare('DELETE FROM user_cards WHERE user_id = ?');
const delDecks = db.prepare('DELETE FROM decks WHERE user_id = ?');
const delRewards = db.prepare('DELETE FROM match_rewards WHERE user_id = ?');
const resetCoins = db.prepare('UPDATE users SET coins = 0 WHERE id = ?');
const resetAvatar = db.prepare("UPDATE users SET avatar = '' WHERE id = ?"); // '' = avatarbase.png par défaut

users.forEach(u => {
  const before = countCards.get(u.id).n;
  const rCards = delCards.run(u.id);
  const rDecks = delDecks.run(u.id);
  const rRewards = delRewards.run(u.id);
  resetCoins.run(u.id);
  resetAvatar.run(u.id);
  console.log(`✔ ${u.name} : ${before} entrée(s) de cartes supprimée(s) (${rCards.changes}), ${rDecks.changes} deck(s) supprimé(s), ${rRewards.changes} récompense(s) effacée(s), pièces remises à 0, avatar remis par défaut (avatarbase.png).`);
});

db.prepare('DELETE FROM shop_state').run();
console.log('✔ Boutique horaire réinitialisée.');

// Vérification finale
console.log('\n--- Vérification après réinitialisation ---');
users.forEach(u => {
  const after = countCards.get(u.id).n;
  const row = db.prepare('SELECT coins, avatar FROM users WHERE id = ?').get(u.id);
  console.log(`  - ${u.name} : ${after} entrée(s) de cartes restantes, ${row.coins} pièces, avatar: ${row.avatar ? '(personnalisé ?!)' : 'par défaut (avatarbase.png)'}.`);
});

console.log(`\n${users.length} compte(s) traité(s) avec succès. Les comptes (email/mot de passe) sont conservés.`);
console.log("Relance le serveur (npm start) puis reconnecte-toi normalement :");
console.log("l'écran de bienvenue et les 5 boosters de départ devraient réapparaître.");
