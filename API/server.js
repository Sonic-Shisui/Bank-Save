const express = require("express");
const cors = require("cors");
const { kv } = require("@vercel/kv");

const app = express();
app.use(cors());
app.use(express.json());

const USER_PREFIX = "bank:user:";
const CARD_PREFIX = "bank:card:";
const TX_PREFIX = "bank:tx:";

async function getUserData(userId) {
    const raw = await kv.get(`${USER_PREFIX}${userId}`);
    if (!raw) return { userId, bank: "0", lastInterestClaimed: Date.now() };
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function setUserData(userId, data) {
    await kv.set(`${USER_PREFIX}${userId}`, JSON.stringify(data));
}

async function getUserCard(userId) {
    const raw = await kv.get(`${CARD_PREFIX}${userId}`);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
}

async function setUserCard(userId, cardData) {
    await kv.set(`${CARD_PREFIX}${userId}`, JSON.stringify(cardData));
}

async function addTransaction(userId, type, amount, details = {}) {
    const key = `${TX_PREFIX}${userId}`;
    const existing = await kv.get(key);
    let txs = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : [];
    txs.unshift({ id: Date.now(), type, amount: amount.toString(), date: Date.now(), details });
    if (txs.length > 50) txs = txs.slice(0, 50);
    await kv.set(key, JSON.stringify(txs));
}

function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (value === undefined || value === null) return 0n;
    return BigInt(String(value));
}

function formatBigInt(value) {
    return value.toString();
}

app.get("/api/bank/:userId", async (req, res) => {
    const { userId } = req.params;
    const user = await getUserData(userId);
    const card = await getUserCard(userId);
    res.json({ success: true, data: { ...user, card: card || null } });
});

app.post("/api/bank/:userId/deposit", async (req, res) => {
    const { userId } = req.params;
    let { amount, cvv } = req.body;
    amount = String(amount);
    if (!/^\d+$/.test(amount)) {
        return res.status(400).json({ success: false, error: "Montant invalide" });
    }
    const card = await getUserCard(userId);
    if (!card || card.cardCvv !== cvv) {
        return res.json({ success: false, error: "CVV incorrect" });
    }
    const user = await getUserData(userId);
    const newBank = toBigInt(user.bank) + toBigInt(amount);
    user.bank = formatBigInt(newBank);
    await setUserData(userId, user);
    await addTransaction(userId, "deposit", user.bank);
    res.json({ success: true, data: { userId, bank: user.bank } });
});

app.post("/api/bank/:userId/withdraw", async (req, res) => {
    const { userId } = req.params;
    let { amount, cvv } = req.body;
    amount = String(amount);
    if (!/^\d+$/.test(amount)) {
        return res.status(400).json({ success: false, error: "Montant invalide" });
    }
    const card = await getUserCard(userId);
    if (!card || card.cardCvv !== cvv) {
        return res.json({ success: false, error: "CVV incorrect" });
    }
    const user = await getUserData(userId);
    const current = toBigInt(user.bank);
    const withdraw = toBigInt(amount);
    if (current < withdraw) {
        return res.json({ success: false, error: "Solde insuffisant" });
    }
    user.bank = formatBigInt(current - withdraw);
    await setUserData(userId, user);
    await addTransaction(userId, "withdraw", user.bank);
    res.json({ success: true, data: { userId, bank: user.bank } });
});

app.post("/api/bank/:userId/card", async (req, res) => {
    const { userId } = req.params;
    let card = await getUserCard(userId);
    if (card && card.cardCreated) {
        return res.json({ success: true, data: card });
    }
    const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const cardNumber = "4532 " + random(1000, 9999) + " " + random(1000, 9999) + " " + random(1000, 9999);
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 4);
    const expiryStr = `${expiry.getMonth()+1}/${expiry.getFullYear().toString().slice(-2)}`;
    const cvv = random(100, 999);
    card = { cardNumber, cardExpiry: expiryStr, cardCvv: cvv, cardCreated: 1 };
    await setUserCard(userId, card);
    res.json({ success: true, data: card });
});

app.post("/api/bank/:userId/interest", async (req, res) => {
    const { userId } = req.params;
    const user = await getUserData(userId);
    const current = toBigInt(user.bank);
    if (current <= 0n) {
        return res.json({ success: false, error: "Aucun argent en banque" });
    }
    const last = user.lastInterestClaimed || Date.now();
    const now = Date.now();
    const secondsDiff = (now - last) / 1000;
    const interest = (current * 1000n * BigInt(Math.floor(secondsDiff))) / 970000000n;
    if (interest > 0n) {
        user.bank = formatBigInt(current + interest);
        user.lastInterestClaimed = now;
        await setUserData(userId, user);
        await addTransaction(userId, "interest", formatBigInt(interest));
        res.json({ success: true, data: { userId, bank: user.bank }, interestEarned: formatBigInt(interest) });
    } else {
        res.json({ success: false, error: "Pas d'intérêt pour le moment" });
    }
});

app.get("/api/bank/top", async (req, res) => {
    const limit = parseInt(req.query.limit) || 25;
    const keys = await kv.keys(`${USER_PREFIX}*`);
    const users = [];
    for (const key of keys) {
        const userId = key.replace(USER_PREFIX, "");
        const raw = await kv.get(key);
        const data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { bank: "0" };
        users.push({ userId, bank: data.bank });
    }
    users.sort((a, b) => {
        const bigA = toBigInt(a.bank);
        const bigB = toBigInt(b.bank);
        return bigB > bigA ? 1 : (bigB < bigA ? -1 : 0);
    });
    res.json({ success: true, data: users.slice(0, limit) });
});

app.get("/api/bank/:userId/transactions", async (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const raw = await kv.get(`${TX_PREFIX}${userId}`);
    const txs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    res.json({ success: true, data: txs.slice(0, limit) });
});

app.post("/api/bank/:userId/transfer", async (req, res) => {
    const { userId } = req.params;
    let { targetId, amount, cvv } = req.body;
    amount = String(amount);
    if (!/^\d+$/.test(amount) || targetId === userId) {
        return res.status(400).json({ success: false, error: "Montant invalide ou transfert à soi-même" });
    }
    const card = await getUserCard(userId);
    if (!card || card.cardCvv !== cvv) {
        return res.json({ success: false, error: "CVV incorrect" });
    }
    const sender = await getUserData(userId);
    const receiver = await getUserData(targetId);
    const senderBank = toBigInt(sender.bank);
    const transferAmount = toBigInt(amount);
    if (senderBank < transferAmount) {
        return res.json({ success: false, error: "Solde insuffisant" });
    }
    sender.bank = formatBigInt(senderBank - transferAmount);
    receiver.bank = formatBigInt(toBigInt(receiver.bank) + transferAmount);
    await setUserData(userId, sender);
    await setUserData(targetId, receiver);
    await addTransaction(userId, "transfer_sent", formatBigInt(-transferAmount), { targetId, amount });
    await addTransaction(targetId, "transfer_received", formatBigInt(transferAmount), { senderId: userId, amount });
    res.json({ success: true, newBalance: sender.bank, targetId, amount });
});

app.post("/api/bank/:userId/rob", async (req, res) => {
    const { userId } = req.params;
    let { targetId, amount } = req.body;
    amount = String(amount);
    if (!/^\d+$/.test(amount) || targetId === userId) {
        return res.status(400).json({ success: false, error: "Montant invalide ou cible invalide" });
    }
    const targetUser = await getUserData(targetId);
    const targetBank = toBigInt(targetUser.bank);
    if (targetBank <= 0n) {
        return res.json({ success: false, error: "Cette personne n'a rien en banque" });
    }
    const robAmount = toBigInt(amount);
    if (robAmount > targetBank) {
        return res.json({ success: false, error: "Montant supérieur au solde de la cible" });
    }
    const robber = await getUserData(userId);
    robber.bank = formatBigInt(toBigInt(robber.bank) + robAmount);
    targetUser.bank = formatBigInt(targetBank - robAmount);
    await setUserData(userId, robber);
    await setUserData(targetId, targetUser);
    await addTransaction(userId, "rob_sent", formatBigInt(robAmount), { targetId });
    await addTransaction(targetId, "rob_received", formatBigInt(-robAmount), { senderId: userId });
    res.json({ success: true, newBalance: robber.bank, robbed: formatBigInt(robAmount), targetId });
});

app.get("/", (req, res) => {
    res.json({ message: "Hedgehog Bank API is running", version: "3.1", status: "online" });
});

module.exports = app;