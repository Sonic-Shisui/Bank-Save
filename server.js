const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, "database", "bank.db");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

// =========== Initialisation des tables (champs TEXT pour les montants) ===========
db.serialize(() => {
  // users : bank et lastInterestClaimed (lastInterestClaimed reste INTEGER pour timestamp)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    bank TEXT DEFAULT '0',
    lastInterestClaimed INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cards (
    userId TEXT PRIMARY KEY,
    cardNumber TEXT,
    cardExpiry TEXT,
    cardCvv INTEGER,
    cardCreated INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parrainage (
    userId TEXT PRIMARY KEY,
    parrainCode TEXT,
    parrainCount INTEGER DEFAULT 0,
    parrainGains TEXT DEFAULT '0',
    parrainUsed INTEGER DEFAULT 0,
    parrainId TEXT,
    parrainList TEXT DEFAULT '[]'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS lottery (
    userId TEXT PRIMARY KEY,
    lotteryTicket INTEGER DEFAULT 0,
    lotteryWon INTEGER DEFAULT 0,
    lotteryWonAmount TEXT DEFAULT '0'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    type TEXT,
    amount TEXT,
    date INTEGER,
    details TEXT DEFAULT '{}'
  )`);
});

// =========== Utilitaires BigInt ===========
function toBigInt(value) {
  // Convertit une valeur (string, number, bigint) en bigint
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null) return 0n;
  return BigInt(String(value));
}

function formatBigInt(value) {
  // Retourne la chaîne décimale sans perte
  return value.toString();
}

// =========== Gestion des utilisateurs ===========
function ensureUserExists(userId, callback) {
  db.run("INSERT OR IGNORE INTO users (userId, bank) VALUES (?, '0')", [userId], (err) => {
    if (err) return callback(err);
    db.run("INSERT OR IGNORE INTO cards (userId) VALUES (?)", [userId]);
    db.run("INSERT OR IGNORE INTO parrainage (userId) VALUES (?)", [userId]);
    db.run("INSERT OR IGNORE INTO lottery (userId) VALUES (?)", [userId]);
    callback(null);
  });
}

// =========== Routes ===========

// GET /api/bank/:userId
app.get("/api/bank/:userId", (req, res) => {
  const { userId } = req.params;
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM users WHERE userId = ?", [userId], (e, user) => {
      if (e) return res.status(500).json({ error: e.message });
      db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
        if (err) return res.status(500).json({ error: err.message });
        // Convert bank en string (déjà stocké en TEXT)
        res.json({ success: true, data: { ...user, card: card || null } });
      });
    });
  });
});

// POST /api/bank/:userId/deposit (dépôt depuis cb)
app.post("/api/bank/:userId/deposit", (req, res) => {
  const { userId } = req.params;
  let { amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount)) {
    return res.status(400).json({ success: false, error: "Montant invalide" });
  }
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!card || card.cardCvv !== cvv) {
        return res.json({ success: false, error: "CVV incorrect" });
      }
      db.get("SELECT bank FROM users WHERE userId = ?", [userId], (e, user) => {
        if (e) return res.status(500).json({ error: e.message });
        const currentBank = toBigInt(user.bank);
        const depositAmount = toBigInt(amount);
        const newBank = currentBank + depositAmount;
        const newBankStr = formatBigInt(newBank);
        db.run("UPDATE users SET bank = ? WHERE userId = ?", [newBankStr, userId]);
        db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'deposit', ?, ?)",
          [userId, newBankStr, Date.now()]);
        res.json({ success: true, data: { userId, bank: newBankStr } });
      });
    });
  });
});

// POST /api/bank/:userId/withdraw
app.post("/api/bank/:userId/withdraw", (req, res) => {
  const { userId } = req.params;
  let { amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount)) {
    return res.status(400).json({ success: false, error: "Montant invalide" });
  }
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!card || card.cardCvv !== cvv) {
        return res.json({ success: false, error: "CVV incorrect" });
      }
      db.get("SELECT bank FROM users WHERE userId = ?", [userId], (e, user) => {
        if (e) return res.status(500).json({ error: e.message });
        const currentBank = toBigInt(user.bank);
        const withdrawAmount = toBigInt(amount);
        if (currentBank < withdrawAmount) {
          return res.json({ success: false, error: "Solde insuffisant" });
        }
        const newBank = currentBank - withdrawAmount;
        const newBankStr = formatBigInt(newBank);
        db.run("UPDATE users SET bank = ? WHERE userId = ?", [newBankStr, userId]);
        db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'withdraw', ?, ?)",
          [userId, newBankStr, Date.now()]);
        res.json({ success: true, data: { userId, bank: newBankStr } });
      });
    });
  });
});

// POST /api/bank/:userId/card (création carte)
app.post("/api/bank/:userId/card", (req, res) => {
  const { userId } = req.params;
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
      if (err) return res.status(500).json({ error: err.message });
      if (card && card.cardCreated) {
        return res.json({ success: true, data: card });
      }
      const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
      const cardNumber = "4532 " + random(1000, 9999) + " " + random(1000, 9999) + " " + random(1000, 9999);
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 4);
      const expiryStr = `${expiry.getMonth()+1}/${expiry.getFullYear().toString().slice(-2)}`;
      const cvv = random(100, 999);
      db.run("UPDATE cards SET cardNumber = ?, cardExpiry = ?, cardCvv = ?, cardCreated = 1 WHERE userId = ?",
        [cardNumber, expiryStr, cvv, userId], (updateErr) => {
          if (updateErr) return res.status(500).json({ error: updateErr.message });
          db.get("SELECT * FROM cards WHERE userId = ?", [userId], (e, newCard) => {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ success: true, data: newCard });
          });
        });
    });
  });
});

// POST /api/bank/:userId/interest
app.post("/api/bank/:userId/interest", (req, res) => {
  const { userId } = req.params;
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM users WHERE userId = ?", [userId], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      const currentBank = toBigInt(user.bank);
      if (currentBank <= 0n) {
        return res.json({ success: false, error: "Aucun argent" });
      }
      const interestRate = 0.001; // 0.1% par jour ? l'ancien code utilisait /970/secondes
      const lastInterest = user.lastInterestClaimed || Date.now();
      const now = Date.now();
      const secondsDiff = (now - lastInterest) / 1000;
      // Intérêt = bank * (interestRate / 970) * secondsDiff (selon l'original)
      // On calcule en BigInt pour éviter les flottants. On va utiliser des nombres décimaux avec une précision suffisante.
      // Pour éviter les pertes, on multiplie par un facteur (1000000) puis on divise.
      const factor = 1000000n;
      const rateNum = Math.floor(interestRate * 1000000); // 0.001 => 1000
      const bankNum = currentBank;
      // (bankNum * rateNum * secondsDiff) / (970 * factor)
      let interest = (bankNum * BigInt(rateNum) * BigInt(Math.floor(secondsDiff))) / (970n * factor);
      interest = interest > 0n ? interest : 0n;
      if (interest > 0n) {
        const newBank = currentBank + interest;
        db.run("UPDATE users SET bank = ?, lastInterestClaimed = ? WHERE userId = ?",
          [formatBigInt(newBank), now, userId]);
        db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'interest', ?, ?)",
          [userId, formatBigInt(interest), now]);
        res.json({ success: true, data: { userId, bank: formatBigInt(newBank) }, interestEarned: formatBigInt(interest) });
      } else {
        res.json({ success: false, error: "Pas d'intérêt pour le moment" });
      }
    });
  });
});

// GET /api/bank/top
app.get("/api/bank/top", (req, res) => {
  const limit = parseInt(req.query.limit) || 25;
  db.all("SELECT userId, bank FROM users ORDER BY CAST(bank AS INTEGER) DESC LIMIT ?", [limit], (err, rows) => {
    // Attention : ORDER BY CAST ne fonctionne que pour des nombres relativement petits (inférieurs à 9e18), car SQLite convertit en INTEGER limité.
    // Pour un tri correct avec des BigInt, il faudrait trier en JavaScript.
    if (err) return res.status(500).json({ error: err.message });
    // On trie avec BigInt côté serveur
    rows.sort((a, b) => {
      const bigA = toBigInt(a.bank);
      const bigB = toBigInt(b.bank);
      return bigB > bigA ? 1 : (bigB < bigA ? -1 : 0);
    });
    res.json({ success: true, data: rows.slice(0, limit) });
  });
});

// GET /api/bank/:userId/transactions
app.get("/api/bank/:userId/transactions", (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 20;
  db.all("SELECT * FROM transactions WHERE userId = ? ORDER BY date DESC LIMIT ?", [userId, limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, data: rows });
  });
});

// POST /api/bank/:userId/parrain/create
app.post("/api/bank/:userId/parrain/create", (req, res) => {
  const { userId } = req.params;
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const code = userId.slice(-6) + random(100, 999);
    db.run("UPDATE parrainage SET parrainCode = ? WHERE userId = ?", [code, userId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, code });
    });
  });
});

// POST /api/bank/:userId/parrain/use
app.post("/api/bank/:userId/parrain/use", (req, res) => {
  const { userId } = req.params;
  const { code } = req.body;
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM parrainage WHERE parrainCode = ?", [code], (err, parrain) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!parrain) return res.json({ success: false, error: "Code invalide" });
      if (parrain.userId === userId) return res.json({ success: false, error: "Vous ne pouvez pas utiliser votre propre code" });
      db.get("SELECT parrainUsed FROM parrainage WHERE userId = ?", [userId], (e, p) => {
        if (e) return res.status(500).json({ error: e.message });
        if (p && p.parrainUsed) return res.json({ success: false, error: "Vous avez déjà utilisé un code" });
        const bonusParraine = 10000n;
        const bonusParrain = 5000n;
        // Mise à jour du parrainé
        db.run("UPDATE parrainage SET parrainUsed = 1, parrainId = ? WHERE userId = ?", [parrain.userId, userId]);
        // Mise à jour du parrain : incrémenter gains
        db.get("SELECT parrainGains FROM parrainage WHERE userId = ?", [parrain.userId], (e2, pdata) => {
          if (e2) return res.status(500).json({ error: e2.message });
          const currentGains = toBigInt(pdata.parrainGains);
          const newGains = currentGains + bonusParrain;
          db.run("UPDATE parrainage SET parrainCount = parrainCount + 1, parrainGains = ? WHERE userId = ?",
            [formatBigInt(newGains), parrain.userId]);
        });
        // Ajout argent aux deux comptes (users)
        db.get("SELECT bank FROM users WHERE userId = ?", [userId], (e3, userParraine) => {
          if (e3) return res.status(500).json({ error: e3.message });
          const oldParraine = toBigInt(userParraine.bank);
          const newParraine = oldParraine + bonusParraine;
          db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newParraine), userId]);
        });
        db.get("SELECT bank FROM users WHERE userId = ?", [parrain.userId], (e4, userParrain) => {
          if (e4) return res.status(500).json({ error: e4.message });
          const oldParrain = toBigInt(userParrain.bank);
          const newParrain = oldParrain + bonusParrain;
          db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newParrain), parrain.userId]);
        });
        db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'parrain_bonus', ?, ?)",
          [userId, formatBigInt(bonusParraine), Date.now()]);
        res.json({ success: true, bonus: formatBigInt(bonusParraine) });
      });
    });
  });
});

// POST /api/bank/:userId/lottery
app.post("/api/bank/:userId/lottery", (req, res) => {
  const { userId } = req.params;
  let { ticketPrice } = req.body;
  ticketPrice = String(ticketPrice);
  if (!/^\d+$/.test(ticketPrice)) {
    return res.status(400).json({ success: false, error: "Montant invalide" });
  }
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT bank FROM users WHERE userId = ?", [userId], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      const currentBank = toBigInt(user.bank);
      const price = toBigInt(ticketPrice);
      if (currentBank < price) {
        return res.json({ success: false, error: "Solde insuffisant" });
      }
      const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
      const userNumbers = [random(1, 9), random(1, 9), random(1, 9)];
      const drawnNumbers = [random(1, 9), random(1, 9), random(1, 9)];
      let matchCount = 0;
      for (let i = 0; i < 3; i++) if (userNumbers[i] === drawnNumbers[i]) matchCount++;
      let win = false, winAmount = 0n, multiplier = 0;
      if (matchCount === 3) { win = true; multiplier = 100; winAmount = price * 100n; }
      else if (matchCount === 2) { win = true; multiplier = 10; winAmount = price * 10n; }
      else if (matchCount === 1) { win = true; multiplier = 2; winAmount = price * 2n; }
      // Déduire le prix du ticket
      let newBank = currentBank - price;
      if (win) newBank = newBank + winAmount;
      db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newBank), userId]);
      if (win) {
        db.run("UPDATE lottery SET lotteryWon = lotteryWon + 1, lotteryWonAmount = lotteryWonAmount + ? WHERE userId = ?",
          [formatBigInt(winAmount), userId]);
      } else {
        db.run("UPDATE lottery SET lotteryTicket = lotteryTicket + 1 WHERE userId = ?", [userId]);
      }
      db.run("INSERT INTO transactions (userId, type, amount, date, details) VALUES (?, ?, ?, ?, ?)",
        [userId, win ? "lottery_win" : "lottery_loss", formatBigInt(win ? winAmount : -price), Date.now(),
         JSON.stringify({ userNumbers, drawnNumbers, matchCount })]);
      res.json({ success: true, win, winAmount: formatBigInt(winAmount), multiplier, userNumbers, drawnNumbers, matchCount, newBalance: formatBigInt(newBank) });
    });
  });
});

// POST /api/bank/:userId/gamble
app.post("/api/bank/:userId/gamble", (req, res) => {
  const { userId } = req.params;
  let { amount, choice } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount) || (choice !== "pile" && choice !== "face")) {
    return res.status(400).json({ success: false, error: "Paramètres invalides" });
  }
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT bank FROM users WHERE userId = ?", [userId], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      const currentBank = toBigInt(user.bank);
      const bet = toBigInt(amount);
      if (currentBank < bet) {
        return res.json({ success: false, error: "Solde insuffisant" });
      }
      const result = Math.random() < 0.5 ? "pile" : "face";
      const win = result === choice;
      let newBank;
      if (win) {
        newBank = currentBank + bet;
      } else {
        newBank = currentBank - bet;
      }
      db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newBank), userId]);
      const winAmount = win ? bet * 2n : 0n;
      db.run("INSERT INTO transactions (userId, type, amount, date, details) VALUES (?, ?, ?, ?, ?)",
        [userId, win ? "gamble_win" : "gamble_loss", formatBigInt(win ? winAmount : -bet), Date.now(),
         JSON.stringify({ choice, result, betAmount: amount })]);
      res.json({ success: true, win, winAmount: formatBigInt(winAmount), choice, result, newBalance: formatBigInt(newBank) });
    });
  });
});

// POST /api/bank/:userId/transfer
app.post("/api/bank/:userId/transfer", (req, res) => {
  const { userId } = req.params;
  let { targetId, amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount) || targetId === userId) {
    return res.status(400).json({ success: false, error: "Montant invalide ou transfert à soi-même" });
  }
  ensureUserExists(userId, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    ensureUserExists(targetId, (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!card || card.cardCvv !== cvv) {
          return res.json({ success: false, error: "CVV incorrect" });
        }
        db.get("SELECT bank FROM users WHERE userId = ?", [userId], (e, sender) => {
          if (e) return res.status(500).json({ error: e.message });
          const senderBank = toBigInt(sender.bank);
          const transferAmount = toBigInt(amount);
          if (senderBank < transferAmount) {
            return res.json({ success: false, error: "Solde insuffisant" });
          }
          const newSender = senderBank - transferAmount;
          db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newSender), userId]);
          db.get("SELECT bank FROM users WHERE userId = ?", [targetId], (e2, receiver) => {
            if (e2) return res.status(500).json({ error: e2.message });
            const receiverBank = toBigInt(receiver.bank);
            const newReceiver = receiverBank + transferAmount;
            db.run("UPDATE users SET bank = ? WHERE userId = ?", [formatBigInt(newReceiver), targetId]);
            db.run("INSERT INTO transactions (userId, type, amount, date, details) VALUES (?, 'transfer_sent', ?, ?, ?)",
              [userId, formatBigInt(-transferAmount), Date.now(), JSON.stringify({ targetId, amount })]);
            db.run("INSERT INTO transactions (userId, type, amount, date, details) VALUES (?, 'transfer_received', ?, ?, ?)",
              [targetId, formatBigInt(transferAmount), Date.now(), JSON.stringify({ senderId: userId, amount })]);
            res.json({ success: true, newBalance: formatBigInt(newSender), targetId, amount });
          });
        });
      });
    });
  });
});

app.listen(PORT, () => console.log(`Bank API running on port ${PORT}`));