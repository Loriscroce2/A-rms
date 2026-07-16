// ===================================================================
// cards-catalog.js — Liste des cartes réellement implémentées dans le jeu
// (miroir de IMPLEMENTED_CODES utilisé côté client dans play.html/index.html)
// ===================================================================
// Si de nouvelles cartes sont ajoutées au jeu plus tard, il faut aussi
// les ajouter ici pour qu'elles apparaissent dans les boosters/la boutique.

const IMPLEMENTED_CODES = [
  1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50, // Krylls
  51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,          // Impy
  88,89,90,91,92,93,94,95,96,97,98,99,100,                                       // Impy (dernier lot, fin de saison 1)
  101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120, // Savage
  151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174, // Chimeria
  175,176,177,178,179,180,181,182,183,184,185,186,187,             // Chimeria (dernier lot, fin de saison 1)
  201,202,203,204,205,206,207,208,209,210,211,212,213,214,        // Wadoo
  215,216,217,218,219,220,                                        // Wadoo (2e lot)
  221,222,223,224,                                                 // Wadoo (3e lot)
  225,226,227,228,                                                 // Wadoo (4e lot)
  229,230,231,232,233,234,                                         // Wadoo (5e lot)
  235,236,                                                          // Wadoo (6e lot)
  237,238,239,240,241,242,243,244,245,247,248,249,250,             // Wadoo (7e lot, sans 246)
];

function pad4(n) { return String(n).padStart(4, '0'); }

function factionOf(n) {
  if (n <= 50) return 'Krylls';
  if (n <= 100) return 'Impy';
  if (n <= 150) return 'Savage';
  if (n <= 200) return 'Chimeria';
  return 'Wadoo';
}

// Une carte a un maximum d'exemplaires possédables plus élevé (Dégourat, C214)
function maxCopiesFor(code) {
  if (code === '0214') return 12;
  if (code === '0032') return 1; // KRYLLS : Bobyz — un seul exemplaire autorisé
  return 2;
}

const ALL_CARDS = IMPLEMENTED_CODES.map(n => ({
  code: pad4(n),
  num: n,
  faction: factionOf(n),
}));

// La Saison 1 réserve 250 emplacements (codes 1 à 250 — 50 par faction),
// MÊME pour les cartes pas encore créées : les boosters et la boutique
// tirent à égalité de chance parmi les 250, pas seulement parmi celles déjà
// implémentées. Une carte non encore créée peut donc être obtenue (elle
// occupera son emplacement dans la collection du joueur, affiché "à venir"
// côté client), mais ne sera utilisable en deck qu'une fois réellement
// implémentée (voir IMPLEMENTED_CODES / ALL_CARDS ci-dessus, qui restent la
// seule source de vérité pour ce qui est jouable).
const SEASON_1_MAX_CODE = 250;
const SEASON_1_ALL_SLOTS = [];
for (let n = 1; n <= SEASON_1_MAX_CODE; n++) {
  SEASON_1_ALL_SLOTS.push({ code: pad4(n), num: n, faction: factionOf(n) });
}

const FACTIONS = ['Krylls', 'Impy', 'Savage', 'Chimeria', 'Wadoo'];

// Utilisée UNIQUEMENT pour la collection de départ des nouveaux joueurs : on
// reste volontairement cantonné aux cartes RÉELLEMENT implémentées, pour
// garantir un deck 100% jouable dès la première partie.
function cardsByFaction(faction) {
  return ALL_CARDS.filter(c => c.faction === faction);
}

// Utilisée pour la boutique et les boosters achetés : équiprobabilité sur les
// 250 emplacements de la Saison 1, implémentés ou non.
function randomCard() {
  return SEASON_1_ALL_SLOTS[Math.floor(Math.random() * SEASON_1_ALL_SLOTS.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Génère une collection de départ qui permet TOUJOURS de construire un deck
// conforme immédiatement : 3 factions aléatoires x 12 cartes chacune = 36 cartes,
// en respectant le nombre maximum d'exemplaires par carte. Le tirage est
// aléatoire avec remise : des doublons (y compris plusieurs Dégourat) sont
// POSSIBLES mais jamais garantis, comme dans un vrai tirage de boosters.
// Renvoyée à la fois en liste plate (36 codes) et déjà répartie en "5 boosters"
// pour l'animation d'ouverture (tailles 7/7/7/7/8, position du booster à 8
// cartes tirée au hasard parmi les 5).
function generateStarterCollection() {
  const chosenFactions = shuffle(FACTIONS).slice(0, 3);
  const codes = [];

  chosenFactions.forEach(fac => {
    const pool = cardsByFaction(fac);
    const counts = new Map();
    let total = 0;
    let guard = 0;
    while (total < 12 && guard < 2000) {
      guard++;
      const card = pool[Math.floor(Math.random() * pool.length)];
      const cur = counts.get(card.code) || 0;
      if (cur < maxCopiesFor(card.code)) {
        counts.set(card.code, cur + 1);
        total++;
      }
    }
    counts.forEach((n, code) => { for (let k = 0; k < n; k++) codes.push(code); });
  });

  const shuffled = shuffle(codes); // 36 codes, ordre aléatoire pour l'ouverture
  const boosterSizes = shuffle([7, 7, 7, 7, 8]); // position du booster à 8 cartes = au hasard
  const boosters = [];
  let cursor = 0;
  boosterSizes.forEach(size => {
    boosters.push(shuffled.slice(cursor, cursor + size));
    cursor += size;
  });

  return { factions: chosenFactions, codes: shuffled, boosters };
}

// Génère un booster "standard" (boutique / achat) : 7 cartes purement aléatoires,
// toutes factions confondues, sans garantie de cohérence.
function generateRandomBooster(size = 7) {
  const codes = [];
  for (let i = 0; i < size; i++) codes.push(randomCard().code);
  return codes;
}

module.exports = { ALL_CARDS, SEASON_1_ALL_SLOTS, SEASON_1_MAX_CODE, FACTIONS, cardsByFaction, randomCard, maxCopiesFor, pad4, factionOf, generateStarterCollection, generateRandomBooster, shuffle };

