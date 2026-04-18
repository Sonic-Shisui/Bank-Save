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

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, bank INTEGER DEFAULT 0, lastInterestClaimed INTEGER DEFAULT (strftime('%s', 'now') * 1000))`);
    db.run(`CREATE TABLE IF NOT EXISTS cards (userId TEXT PRIMARY KEY, cardNumber TEXT, cardExpiry TEXT, cardCvv INTEGER, cardCreated INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS parrainage (userId TEXT PRIMARY KEY, parrainCode TEXT, parrainCount INTEGER DEFAULT 0, parrainGains INTEGER DEFAULT 0, parrainUsed INTEGER DEFAULT 0, parrainId TEXT, parrainList TEXT DEFAULT '[]')`);
    db.run(`CREATE TABLE IF NOT EXISTS lottery (userId TEXT PRIMARY KEY, lotteryTicket INTEGER DEFAULT 0, lotteryWon INTEGER DEFAULT 0, lotteryWonAmount INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, type TEXT, amount INTEGER, date INTEGER, details TEXT DEFAULT '{}')`);
});

const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

app.get("/api/bank/:userId", (req, res) => {
    const { userId } = req.params;
    db.get("SELECT * FROM users WHERE userId = ?", [userId], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) {
            db.run("INSERT INTO users (userId) VALUES (?)", [userId]);
            db.run("INSERT INTO cards (userId) VALUES (?)", [userId]);
            db.run("INSERT INTO parrainage (userId) VALUES (?)", [userId]);
            db.run("INSERT INTO lottery (userId) VALUES (?)", [userId]);
            return res.json({ success: true, data: { userId, bank: 0 } });
        }
        const card = await new Promise((resolve) => db.get("SELECT * FROM cards WHERE userId = ?", [userId], (e, r) => resolve(r)));
        res.json({ success: true, data: { ...user, card } });
    });
});

app.post("/api/bank/:userId/deposit", (req, res) => {
    const { userId } = req.params;
    const { amount, cvv } = req.body;
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!card || card.cardCvv !== cvv) return res.json({ success: false, error: "CVV incorrect" });
        db.run("UPDATE users SET bank = bank + ? WHERE userId = ?", [amount, userId]);
        db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'deposit', ?, ?)", [userId, amount, Date.now()]);
        db.get("SELECT * FROM users WHERE userId = ?", [userId], (e, user) => {
            res.json({ success: true, data: user });
        });
    });
});

app.post("/api/bank/:userId/withdraw", (req, res) => {
    const { userId } = req.params;
    const { amount, cvv } = req.body;
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!card || card.cardCvv !== cvv) return res.json({ success: false, error: "CVV incorrect" });
        db.get("SELECT * FROM users WHERE userId = ?", [userId], (e, user) => {
            if (amount > user.bank) return res.json({ success: false, error: "Solde insuffisant" });
            db.run("UPDATE users SET bank = bank - ? WHERE userId = ?", [amount, userId]);
            db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'withdraw', -?, ?)", [userId, amount, Date.now()]);
            db.get("SELECT * FROM users WHERE userId = ?", [userId], (e2, newUser) => {
                res.json({ success: true, data: newUser });
            });
        });
    });
});

app.post("/api/bank/:userId/card", (req, res) => {
    const { userId } = req.params;
    db.get("SELECT * FROM cards WHERE userId = ?", [userId], (err, card) => {
        if (card && card.cardCreated) return res.json({ success: true, data: card });
        const cardNumber = "4532 " + random(1000, 9999) + " " + random(1000, 9999) + " " + random(1000, 9999);
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 4);
        const expiryStr = `${expiry.getMonth()+1}/${expiry.getFullYear().toString().slice(-2)}`;
        const cvv = random(100, 999);
        db.run("UPDATE cards SET cardNumber = ?, cardExpiry = ?, cardCvv = ?, cardCreated = 1 WHERE userId = ?", [cardNumber, expiryStr, cvv, userId]);
        db.get("SELECT * FROM cards WHERE userId = ?", [userId], (e, newCard) => {
            res.json({ success: true, data: newCard });
        });
    });
});

app.post("/api/bank/:userId/interest", (req, res) => {
    const { userId } = req.params;
    db.get("SELECT * FROM users WHERE userId = ?", [userId], (err, user) => {
        if (user.bank <= 0) return res.json({ success: false, error: "Aucun argent" });
        const interestRate = 0.001;
        const lastInterest = user.lastInterestClaimed || Date.now();
        const now = Date.now();
        const interest = user.bank * (interestRate / 970) * ((now - lastInterest) / 1000);
        if (interest > 0) {
            db.run("UPDATE users SET bank = bank + ?, lastInterestClaimed = ? WHERE userId = ?", [interest, now, userId]);
            db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'interest', ?, ?)", [userId, interest, now]);
        }
        db.get("SELECT * FROM users WHERE userId = ?", [userId], (e, newUser) => {
            res.json({ success: true, data: newUser, interestEarned: interest });
        });
    });
});

app.get("/api/bank/top", (req, res) => {
    const limit = parseInt(req.query.limit) || 25;
    db.all("SELECT userId, bank FROM users ORDER BY bank DESC LIMIT ?", [limit], (err, rows) => {
        res.json({ success: true, data: rows });
    });
});

app.get("/api/bank/:userId/transactions", (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    db.all("SELECT * FROM transactions WHERE userId = ? ORDER BY date DESC LIMIT ?", [userId, limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.post("/api/bank/:userId/parrain/create", (req, res) => {
    const { userId } = req.params;
    const code = userId.slice(-6) + random(100, 999);
    db.run("UPDATE parrainage SET parrainCode = ? WHERE userId = ?", [code, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, code });
    });
});

app.post("/api/bank/:userId/parrain/use", (req, res) => {
    const { userId } = req.params;
    const { code } = req.body;
    db.get("SELECT * FROM parrainage WHERE parrainCode = ?", [code], (err, parrain) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!parrain) return res.json({ success: false, error: "Code invalide" });
        if (parrain.userId === userId) return res.json({ success: false, error: "Vous ne pouvez pas utiliser votre propre code" });
        db.get("SELECT parrainUsed FROM parrainage WHERE userId = ?", [userId], (e, p) => {
            if (p && p.parrainUsed) return res.json({ success: false, error: "Vous avez deja utilise un code" });
            const bonusParraine = 10000;
            const bonusParrain = 5000;
            db.run("UPDATE parrainage SET parrainUsed = 1, parrainId = ? WHERE userId = ?", [parrain.userId, userId]);
            db.run("UPDATE parrainage SET parrainCount = parrainCount + 1, parrainGains = parrainGains + ? WHERE userId = ?", [bonusParrain, parrain.userId]);
            db.run("UPDATE users SET bank = bank + ? WHERE userId = ?", [bonusParraine, userId]);
            db.run("UPDATE users SET bank = bank + ? WHERE userId = ?", [bonusParrain, parrain.userId]);
            db.run("INSERT INTO transactions (userId, type, amount, date) VALUES (?, 'parrain_bonus', ?, ?)", [userId, bonusParraine, Date.now()]);
            res.json({ success: true, bonus: bonusParraine });
        });
    });
});

app.post("/api/bank/:userId/lottery", (req, res) => {
    const { userId } = req.params;
    const { ticketPrice } = req.body;
    db.get("SELECT bank FROM users WHERE userId = ?", [userId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user || ticketPrice > user.bank) return res.json({ success: false, error: "Solde insuffisant" });
        const userNumbers = [random(1, 9), random(1, 9), random(1, 9)];
        const drawnNumbers = [random(1, 9), random(1, 9), random(1, 9)];
        let matchCount = 0;
        for (let i = 0; i < 3; i++) if (userNumbers[i] === drawnNumbers[i]) matchCount++;
        let win = false, winAmount = 0, multiplier = 0;
        if (matchCount === 3) { win = true; multiplier = 100; winAmount = ticketPrice * multiplier; }
        else if (matchCount === 2) { win = true; multiplier = 10; winAmount = ticketPrice * multiplier; }
        else if (matchCount === 1) { win = true; multiplier = 2; winAmount = ticketPrice * multiplier; }
        db.run("UPDATE users SET bank = bank - ? WHERE userId = ?", [ticketPrice, userId]);
        if (win) {
            db.run("UPDATE users SET bank = bank + ? WHERE userId = ?", [winAmount, userId]);
            db.run("UPDATE lottery SET lotteryWon = lotteryWon + 1, lotteryWonAmount = lotteryWonAmount + ? WHERE userId = ?", [winAmount, userId]);
        } else {
            db.run("UPDATE lottery SET lotteryTicket = lotteryTicket + 1 WHERE userId = ?", [userId]);
        }
        db.run("INSERT INTO transactions (userId, type, amount, date, details) VALUES (?, ?, ?, ?, ?)", 
            [userId, win ? "lottery_win" : "lottery_loss", win ? winAmount : -ticketPrice, Date.now(), JSON.stringify({ userNumbers, drawnNumbers, matchCount })]);
        db.get("SELECT bank FROM users WHERE userId = ?", [userId], (e, newUser) => {
            res.json({ success: true, win, winAmount, multiplier, userNumbers, drawnNumbers, matchCount, newBalance: newUser.bank });
        });
    });
});

app.listen(PORT, () => console.log(`Bank API running on port ${PORT}`));