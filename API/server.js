const express = require("express");
const cors = require("cors");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_PREFIX = "bank:user:";
const CARD_PREFIX = "bank:card:";
const TX_PREFIX = "bank:tx:";

async function getUserData(userId) {
  const raw = await redis.get(`${USER_PREFIX}${userId}`);
  if (!raw) return { userId, bank: "0", lastInterestClaimed: Date.now() };
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function setUserData(userId, data) {
  await redis.set(`${USER_PREFIX}${userId}`, JSON.stringify(data));
}

async function getUserCard(userId) {
  const raw = await redis.get(`${CARD_PREFIX}${userId}`);
  return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
}

async function setUserCard(userId, cardData) {
  await redis.set(`${CARD_PREFIX}${userId}`, JSON.stringify(cardData));
}

async function addTransaction(userId, type, amount, details = {}) {
  const key = `${TX_PREFIX}${userId}`;
  const existing = await redis.get(key);
  let transactions = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : [];
  transactions.unshift({ id: Date.now(), type, amount: amount.toString(), date: Date.now(), details });
  if (transactions.length > 50) transactions = transactions.slice(0, 50);
  await redis.set(key, JSON.stringify(transactions));
}

async function getTransactions(userId, limit = 20) {
  const raw = await redis.get(`${TX_PREFIX}${userId}`);
  const transactions = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  return transactions.slice(0, limit);
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null) return 0n;
  return BigInt(String(value));
}

function formatBigInt(value) { return value.toString(); }

app.get("/api/bank/:userId", async (req, res) => {
  const { userId } = req.params;
  const userData = await getUserData(userId);
  const card = await getUserCard(userId);
  res.json({ success: true, data: { ...userData, card: card || null } });
});

app.post("/api/bank/:userId/deposit", async (req, res) => {
  const { userId } = req.params;
  let { amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount)) return res.status(400).json({ success: false, error: "Montant invalide" });
  const card = await getUserCard(userId);
  if (!card || card.cardCvv !== cvv) return res.json({ success: false, error: "CVV incorrect" });
  const userData = await getUserData(userId);
  const newBank = toBigInt(userData.bank) + toBigInt(amount);
  userData.bank = formatBigInt(newBank);
  await setUserData(userId, userData);
  await addTransaction(userId, "deposit", userData.bank);
  res.json({ success: true, data: { userId, bank: userData.bank } });
});

app.post("/api/bank/:userId/withdraw", async (req, res) => {
  const { userId } = req.params;
  let { amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount)) return res.status(400).json({ success: false, error: "Montant invalide" });
  const card = await getUserCard(userId);
  if (!card || card.cardCvv !== cvv) return res.json({ success: false, error: "CVV incorrect" });
  const userData = await getUserData(userId);
  const current = toBigInt(userData.bank);
  const withdraw = toBigInt(amount);
  if (current < withdraw) return res.json({ success: false, error: "Solde insuffisant" });
  userData.bank = formatBigInt(current - withdraw);
  await setUserData(userId, userData);
  await addTransaction(userId, "withdraw", userData.bank);
  res.json({ success: true, data: { userId, bank: userData.bank } });
});

app.post("/api/bank/:userId/card", async (req, res) => {
  const { userId } = req.params;
  let card = await getUserCard(userId);
  if (card?.cardCreated) return res.json({ success: true, data: card });
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
  const userData = await getUserData(userId);
  const current = toBigInt(userData.bank);
  if (current <= 0n) return res.json({ success: false, error: "Aucun argent" });
  const last = userData.lastInterestClaimed || Date.now();
  const now = Date.now();
  const diff = (now - last) / 1000;
  const interest = (current * 1000n * BigInt(Math.floor(diff))) / 970000000n;
  if (interest > 0n) {
    userData.bank = formatBigInt(current + interest);
    userData.lastInterestClaimed = now;
    await setUserData(userId, userData);
    await addTransaction(userId, "interest", userData.bank);
    res.json({ success: true, data: { userId, bank: userData.bank }, interestEarned: formatBigInt(interest) });
  } else {
    res.json({ success: false, error: "Pas d'intérêt pour le moment" });
  }
});

app.get("/api/bank/top", async (req, res) => {
  const limit = parseInt(req.query.limit) || 25;
  const keys = await redis.keys(`${USER_PREFIX}*`);
  const users = [];
  for (const key of keys) {
    const userId = key.replace(USER_PREFIX, "");
    const raw = await redis.get(key);
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
  const txs = await getTransactions(userId, limit);
  res.json({ success: true, data: txs });
});

app.post("/api/bank/:userId/transfer", async (req, res) => {
  const { userId } = req.params;
  let { targetId, amount, cvv } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount) || targetId === userId) {
    return res.status(400).json({ success: false, error: "Montant invalide" });
  }
  const card = await getUserCard(userId);
  if (!card || card.cardCvv !== cvv) return res.json({ success: false, error: "CVV incorrect" });
  const sender = await getUserData(userId);
  const receiver = await getUserData(targetId);
  const senderBank = toBigInt(sender.bank);
  const transfer = toBigInt(amount);
  if (senderBank < transfer) return res.json({ success: false, error: "Solde insuffisant" });
  sender.bank = formatBigInt(senderBank - transfer);
  receiver.bank = formatBigInt(toBigInt(receiver.bank) + transfer);
  await setUserData(userId, sender);
  await setUserData(targetId, receiver);
  await addTransaction(userId, "transfer_sent", formatBigInt(-transfer), { targetId, amount });
  await addTransaction(targetId, "transfer_received", formatBigInt(transfer), { senderId: userId, amount });
  res.json({ success: true, newBalance: sender.bank, targetId, amount });
});

app.get("/", (req, res) => {
  res.json({ message: "Hedgehog Bank API is running", version: "4.0", status: "online", storage: "Upstash Redis" });
});

module.exports = app;