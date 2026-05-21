const express = require("express");
const cors = require("cors");
const { kv } = require("@vercel/kv");

const app = express();
app.use(cors());
app.use(express.json());

const USER_PREFIX = "bank:user:";
const CARD_PREFIX = "bank:card:";
const TX_PREFIX = "bank:tx:";
const PARRAIN_USER_PREFIX = "bank:parrain:user:";
const PARRAIN_CODE_PREFIX = "bank:parrain:code:";
const PARRAIN_USED_PREFIX = "bank:parrain:used:";

function toBigInt(value) {
    if (typeof value === "bigint") return value;
    if (value === undefined || value === null) return 0n;
    try {
        const clean = String(value).split(".")[0].replace(/[^0-9\-]/g, "") || "0";
        return BigInt(clean);
    } catch { return 0n; }
}

function fmt(v) {
    if (v === undefined || v === null) return "0";
    return toBigInt(v).toString();
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getUserData(userId) {
    try {
        const raw = await kv.get(`${USER_PREFIX}${userId}`);
        if (!raw) return { userId, bank: "0", lastInterestClaimed: Date.now(), imageMode: true };
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch(e) {
        return { userId, bank: "0", lastInterestClaimed: Date.now(), imageMode: true };
    }
}

async function setUserData(userId, data) {
    data.bank = fmt(data.bank);
    await kv.set(`${USER_PREFIX}${userId}`, JSON.stringify(data));
}

async function getUserCard(userId) {
    try {
        const raw = await kv.get(`${CARD_PREFIX}${userId}`);
        if (!raw) return null;
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch(e) { return null; }
}

async function setUserCard(userId, cardData) {
    await kv.set(`${CARD_PREFIX}${userId}`, JSON.stringify(cardData));
}

async function addTransaction(userId, type, amount, details = {}) {
    try {
        const key = `${TX_PREFIX}${userId}`;
        const existing = await kv.get(key);
        let txs = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : [];
        txs.unshift({ id: Date.now(), type, amount: fmt(amount), date: Date.now(), details });
        if (txs.length > 50) txs = txs.slice(0, 50);
        await kv.set(key, JSON.stringify(txs));
    } catch(e) {}
}

app.get("/", (req, res) => {
    res.json({ message: "Hedgehog Bank API", version: "5.0", status: "online" });
});

app.get("/api/bank/top", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const keys = await kv.keys(`${USER_PREFIX}*`);
        const users = [];
        for (const key of keys) {
            const userId = key.replace(USER_PREFIX, "");
            try {
                const raw = await kv.get(key);
                const data = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : { bank: "0" };
                users.push({ userId, bank: fmt(data.bank || "0") });
            } catch(e) {
                users.push({ userId, bank: "0" });
            }
        }
        users.sort((a, b) => {
            const diff = toBigInt(b.bank) - toBigInt(a.bank);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        res.json({ success: true, data: users.slice(0, limit) });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUserData(userId);
        const card = await getUserCard(userId);
        res.json({ success: true, data: { ...user, bank: fmt(user.bank), card: card || null, imageMode: user.imageMode !== false } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/card", async (req, res) => {
    try {
        const { userId } = req.params;
        let card = await getUserCard(userId);
        if (card && card.cardCreated) {
            return res.json({ success: true, data: card });
        }
        const cardNumber = `4532 ${rand(1000,9999)} ${rand(1000,9999)} ${rand(1000,9999)}`;
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 4);
        const expiryStr = `${expiry.getMonth()+1}/${expiry.getFullYear().toString().slice(-2)}`;
        const cvv = rand(100, 999);
        card = { cardNumber, cardExpiry: expiryStr, cardCvv: cvv, cardCreated: 1 };
        await setUserCard(userId, card);
        res.json({ success: true, data: card });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/deposit", async (req, res) => {
    try {
        const { userId } = req.params;
        let { amount, cvv } = req.body;
        amount = String(amount || "").trim();
        if (!/^\d+$/.test(amount) || amount === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        const card = await getUserCard(userId);
        if (!card) return res.json({ success: false, error: "Aucune carte associée" });
        if (card.cardCvv !== parseInt(cvv)) return res.json({ success: false, error: "CVV incorrect" });
        const user = await getUserData(userId);
        user.bank = fmt(toBigInt(user.bank) + toBigInt(amount));
        await setUserData(userId, user);
        await addTransaction(userId, "deposit", amount);
        res.json({ success: true, data: { userId, bank: user.bank } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/withdraw", async (req, res) => {
    try {
        const { userId } = req.params;
        let { amount, cvv } = req.body;
        amount = String(amount || "").trim();
        if (!/^\d+$/.test(amount) || amount === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        const card = await getUserCard(userId);
        if (!card) return res.json({ success: false, error: "Aucune carte associée" });
        if (card.cardCvv !== parseInt(cvv)) return res.json({ success: false, error: "CVV incorrect" });
        const user = await getUserData(userId);
        const current = toBigInt(user.bank);
        const withdraw = toBigInt(amount);
        if (current < withdraw) return res.json({ success: false, error: "Solde insuffisant" });
        user.bank = fmt(current - withdraw);
        await setUserData(userId, user);
        await addTransaction(userId, "withdraw", amount);
        res.json({ success: true, data: { userId, bank: user.bank } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/transfer", async (req, res) => {
    try {
        const { userId } = req.params;
        let { targetId, amount, cvv } = req.body;
        amount = String(amount || "").trim();
        if (!/^\d+$/.test(amount) || amount === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!targetId || targetId === userId) {
            return res.status(400).json({ success: false, error: "Cible invalide" });
        }
        const card = await getUserCard(userId);
        if (!card) return res.json({ success: false, error: "Aucune carte associée" });
        if (card.cardCvv !== parseInt(cvv)) return res.json({ success: false, error: "CVV incorrect" });
        const sender = await getUserData(userId);
        const receiver = await getUserData(targetId);
        const senderBal = toBigInt(sender.bank);
        const amt = toBigInt(amount);
        if (senderBal < amt) return res.json({ success: false, error: "Solde insuffisant" });
        sender.bank = fmt(senderBal - amt);
        receiver.bank = fmt(toBigInt(receiver.bank) + amt);
        await setUserData(userId, sender);
        await setUserData(targetId, receiver);
        await addTransaction(userId, "transfer_sent", fmt(-amt), { targetId, amount });
        await addTransaction(targetId, "transfer_received", amount, { senderId: userId, amount });
        res.json({ success: true, newBalance: sender.bank, targetId, amount });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/rob", async (req, res) => {
    try {
        const { userId } = req.params;
        let { targetId, amount } = req.body;
        amount = String(amount || "").trim();
        if (!/^\d+$/.test(amount) || amount === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!targetId || targetId === userId) {
            return res.status(400).json({ success: false, error: "Cible invalide" });
        }
        const victim = await getUserData(targetId);
        const victimBal = toBigInt(victim.bank);
        const robAmt = toBigInt(amount);
        if (victimBal <= 0n) return res.json({ success: false, error: "La cible n'a rien en banque" });
        if (robAmt > victimBal) return res.json({ success: false, error: "Montant supérieur au solde de la cible" });
        const robber = await getUserData(userId);
        robber.bank = fmt(toBigInt(robber.bank) + robAmt);
        victim.bank = fmt(victimBal - robAmt);
        await setUserData(userId, robber);
        await setUserData(targetId, victim);
        await addTransaction(userId, "rob_sent", fmt(robAmt), { targetId });
        await addTransaction(targetId, "rob_received", fmt(-robAmt), { senderId: userId });
        res.json({ success: true, newBalance: robber.bank, robbed: fmt(robAmt) });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/interest", async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUserData(userId);
        const current = toBigInt(user.bank);
        if (current <= 0n) return res.json({ success: false, error: "Aucun argent en banque" });
        const now = Date.now();
        const last = user.lastInterestClaimed || now;
        const diff = (now - last) / 1000;
        const interest = (current * 1000n * BigInt(Math.floor(diff))) / 970000000n;
        if (interest <= 0n) return res.json({ success: false, error: "Pas encore d'intérêts disponibles" });
        user.bank = fmt(current + interest);
        user.lastInterestClaimed = now;
        await setUserData(userId, user);
        await addTransaction(userId, "interest", fmt(interest));
        res.json({ success: true, data: { userId, bank: user.bank }, interestEarned: fmt(interest) });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/gamble", async (req, res) => {
    try {
        const { userId } = req.params;
        let { amount, choice } = req.body;
        amount = String(amount || "").trim();
        if (!/^\d+$/.test(amount) || amount === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        if (!["pile", "face"].includes(choice)) {
            return res.status(400).json({ success: false, error: "Choix invalide" });
        }
        const user = await getUserData(userId);
        const bal = toBigInt(user.bank);
        const bet = toBigInt(amount);
        if (bal < bet) return res.json({ success: false, error: "Solde insuffisant" });
        const result = Math.random() < 0.5 ? "pile" : "face";
        const win = result === choice;
        user.bank = fmt(win ? bal + bet : bal - bet);
        await setUserData(userId, user);
        await addTransaction(userId, win ? "gamble_win" : "gamble_lose", win ? fmt(bet) : fmt(-bet));
        res.json({ success: true, win, result, winAmount: win ? fmt(bet) : "0", newBalance: user.bank });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/lottery", async (req, res) => {
    try {
        const { userId } = req.params;
        let { ticketPrice } = req.body;
        ticketPrice = String(ticketPrice || "").trim();
        if (!/^\d+$/.test(ticketPrice) || ticketPrice === "0") {
            return res.status(400).json({ success: false, error: "Montant invalide" });
        }
        const user = await getUserData(userId);
        const ticket = toBigInt(ticketPrice);
        if (ticket > toBigInt(user.bank)) {
            return res.json({ success: false, error: "Solde insuffisant" });
        }
        const userNumbers = [rand(1, 9), rand(1, 9), rand(1, 9)];
        const drawnNumbers = [rand(1, 9), rand(1, 9), rand(1, 9)];
        let matchCount = 0;
        for (let i = 0; i < 3; i++) {
            if (userNumbers[i] === drawnNumbers[i]) matchCount++;
        }
        let multiplier = 0;
        if (matchCount === 3) multiplier = 100;
        else if (matchCount === 2) multiplier = 10;
        else if (matchCount === 1) multiplier = 2;
        const win = multiplier > 0;
        const winAmount = win ? ticket * BigInt(multiplier) : 0n;
        user.bank = fmt(toBigInt(user.bank) - ticket);
        if (win) {
            user.bank = fmt(toBigInt(user.bank) + winAmount);
        }
        await setUserData(userId, user);
        await addTransaction(userId, win ? "lottery_win" : "lottery_lose", win ? fmt(winAmount) : fmt(-ticket));
        res.json({ success: true, win, userNumbers, drawnNumbers, matchCount, multiplier, winAmount: fmt(winAmount), newBalance: user.bank });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/bank/:userId/transactions", async (req, res) => {
    try {
        const { userId } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const raw = await kv.get(`${TX_PREFIX}${userId}`);
        const txs = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
        res.json({ success: true, data: txs.slice(0, limit) });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/parrain/create", async (req, res) => {
    try {
        const { userId } = req.params;
        const existing = await kv.get(`${PARRAIN_USER_PREFIX}${userId}`);
        if (existing) {
            const d = typeof existing === "string" ? JSON.parse(existing) : existing;
            return res.json({ success: true, code: d.code });
        }
        const code = "HHG" + Math.random().toString(36).substring(2, 8).toUpperCase();
        await kv.set(`${PARRAIN_USER_PREFIX}${userId}`, JSON.stringify({ code, count: 0, gains: "0" }));
        await kv.set(`${PARRAIN_CODE_PREFIX}${code}`, userId);
        res.json({ success: true, code });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/parrain/use", async (req, res) => {
    try {
        const { userId } = req.params;
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: "Code manquant" });
        const used = await kv.get(`${PARRAIN_USED_PREFIX}${userId}`);
        if (used) return res.json({ success: false, error: "Code déjà utilisé" });
        const ownerId = await kv.get(`${PARRAIN_CODE_PREFIX}${code}`);
        if (!ownerId) return res.json({ success: false, error: "Code invalide" });
        if (ownerId === userId) return res.json({ success: false, error: "Vous ne pouvez pas utiliser votre propre code" });
        const BONUS_USER = 10000n;
        const BONUS_OWNER = 5000n;
        const userD = await getUserData(userId);
        const ownerD = await getUserData(ownerId);
        userD.bank = fmt(toBigInt(userD.bank) + BONUS_USER);
        ownerD.bank = fmt(toBigInt(ownerD.bank) + BONUS_OWNER);
        await setUserData(userId, userD);
        await setUserData(ownerId, ownerD);
        await kv.set(`${PARRAIN_USED_PREFIX}${userId}`, code);
        const op = await kv.get(`${PARRAIN_USER_PREFIX}${ownerId}`);
        if (op) {
            const d = typeof op === "string" ? JSON.parse(op) : op;
            d.count++;
            d.gains = fmt(toBigInt(d.gains) + BONUS_OWNER);
            await kv.set(`${PARRAIN_USER_PREFIX}${ownerId}`, JSON.stringify(d));
        }
        await addTransaction(userId, "parrain_bonus", fmt(BONUS_USER), { code });
        await addTransaction(ownerId, "parrain_referral", fmt(BONUS_OWNER), { referredUser: userId });
        res.json({ success: true, bonusUser: fmt(BONUS_USER), bonusOwner: fmt(BONUS_OWNER), newBalance: userD.bank });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/parrain/stats", async (req, res) => {
    try {
        const { userId } = req.params;
        const raw = await kv.get(`${PARRAIN_USER_PREFIX}${userId}`);
        if (!raw) return res.json({ success: false, error: "Aucun code de parrainage" });
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        res.json({ success: true, data: { code: data.code, count: data.count || 0, gains: data.gains || "0" } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/bank/:userId/image", async (req, res) => {
    try {
        const { userId } = req.params;
        const { mode } = req.body;
        if (mode !== "on" && mode !== "off") {
            return res.status(400).json({ success: false, error: "Mode invalide (on/off)" });
        }
        const user = await getUserData(userId);
        user.imageMode = mode === "on";
        await setUserData(userId, user);
        res.json({ success: true, imageMode: user.imageMode });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = app;