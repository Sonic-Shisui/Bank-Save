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

const PREFIX = {
  user: "bank:user:",
  card: "bank:card:",
  tx: "bank:tx:",
  parrain: "bank:parrain:",
  lottery: "bank:lottery:",
};

async function getUserData(userId) {
  const raw = await redis.get(`${PREFIX.user}${userId}`);
  if (!raw) return { userId, bank: "0", lastInterestClaimed: Date.now() };
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function setUserData(userId, data) {
  await redis.set(`${PREFIX.user}${userId}`, JSON.stringify(data));
}

async function getUserCard(userId) {
  const raw = await redis.get(`${PREFIX.card}${userId}`);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
}

async function setUserCard(userId, cardData) {
  await redis.set(`${PREFIX.card}${userId}`, JSON.stringify(cardData));
}

async function addTransaction(userId, type, amount, details = {}) {
  const key = `${PREFIX.tx}${userId}`;
  const existing = await redis.get(key);
  let txs = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : [];
  txs.unshift({ id: Date.now(), type, amount: amount.toString(), date: Date.now(), details });
  if (txs.length > 50) txs = txs.slice(0, 50);
  await redis.set(key, JSON.stringify(txs));
}

async function getTransactions(userId, limit = 20) {
  const raw = await redis.get(`${PREFIX.tx}${userId}`);
  const txs = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
  return txs.slice(0, limit);
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (value === undefined || value === null) return 0n;
  return BigInt(String(value));
}

function formatBigInt(value) {
  return value.toString();
}

// ==================== ROUTES ====================

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
  const expiryStr = `${expiry.getMonth() + 1}/${expiry.getFullYear().toString().slice(-2)}`;
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
  const keys = await redis.keys(`${PREFIX.user}*`);
  const users = [];
  for (const key of keys) {
    const userId = key.replace(PREFIX.user, "");
    const raw = await redis.get(key);
    const data = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : { bank: "0" };
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

app.post("/api/bank/:userId/gamble", async (req, res) => {
  const { userId } = req.params;
  let { amount, choice } = req.body;
  amount = String(amount);
  if (!/^\d+$/.test(amount) || (choice !== "pile" && choice !== "face")) {
    return res.status(400).json({ success: false, error: "Paramètres invalides" });
  }
  const user = await getUserData(userId);
  const current = toBigInt(user.bank);
  const bet = toBigInt(amount);
  if (current < bet) {
    return res.json({ success: false, error: "Solde insuffisant" });
  }
  const result = Math.random() < 0.5 ? "pile" : "face";
  const win = result === choice;
  const newBank = win ? current + bet : current - bet;
  user.bank = formatBigInt(newBank);
  await setUserData(userId, user);
  const winAmount = win ? bet * 2n : 0n;
  await addTransaction(userId, win ? "gamble_win" : "gamble_loss", formatBigInt(win ? winAmount : -bet), { choice, result });
  res.json({ success: true, win, winAmount: formatBigInt(winAmount), choice, result, newBalance: user.bank });
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

app.post("/api/bank/:userId/lottery", async (req, res) => {
  const { userId } = req.params;
  let { ticketPrice } = req.body;
  ticketPrice = String(ticketPrice);
  if (!/^\d+$/.test(ticketPrice)) {
    return res.status(400).json({ success: false, error: "Montant invalide" });
  }
  const user = await getUserData(userId);
  const current = toBigInt(user.bank);
  const price = toBigInt(ticketPrice);
  if (current < price) {
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
  const newBank = current - price + (win ? winAmount : 0n);
  user.bank = formatBigInt(newBank);
  await setUserData(userId, user);
  await addTransaction(userId, win ? "lottery_win" : "lottery_loss", formatBigInt(win ? winAmount : -price), { userNumbers, drawnNumbers, matchCount });
  res.json({ success: true, win, winAmount: formatBigInt(winAmount), multiplier, userNumbers, drawnNumbers, matchCount, newBalance: user.bank });
});

app.post("/api/bank/:userId/parrain/create", async (req, res) => {
  const { userId } = req.params;
  const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const code = userId.slice(-6) + random(100, 999);
  await redis.set(`${PREFIX.parrain}${userId}`, JSON.stringify({ code, count: 0, gains: "0" }));
  res.json({ success: true, code });
});

app.post("/api/bank/:userId/parrain/use", async (req, res) => {
  const { userId } = req.params;
  const { code } = req.body;
  const keys = await redis.keys(`${PREFIX.parrain}*`);
  let parrainId = null;
  for (const key of keys) {
    const raw = await redis.get(key);
    const data = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (data && data.code === code) {
      parrainId = key.replace(PREFIX.parrain, "");
      break;
    }
  }
  if (!parrainId) return res.json({ success: false, error: "Code invalide" });
  if (parrainId === userId) return res.json({ success: false, error: "Vous ne pouvez pas utiliser votre propre code" });
  const existing = await redis.get(`${PREFIX.user}${userId}`);
  if (existing) return res.json({ success: false, error: "Vous avez déjà utilisé un code" });
  const bonusParraine = 10000n;
  const bonusParrain = 5000n;
  const user = await getUserData(userId);
  const parrain = await getUserData(parrainId);
  user.bank = formatBigInt(toBigInt(user.bank) + bonusParraine);
  parrain.bank = formatBigInt(toBigInt(parrain.bank) + bonusParrain);
  await setUserData(userId, user);
  await setUserData(parrainId, parrain);
  await addTransaction(userId, "parrain_bonus", formatBigInt(bonusParraine), { code });
  await addTransaction(parrainId, "parrain_bonus", formatBigInt(bonusParrain), { code, parraine: userId });
  res.json({ success: true, bonus: formatBigInt(bonusParraine) });
});

app.get("/", (req, res) => {
  res.json({ message: "Hedgehog Bank API is running", version: "4.1", status: "online", storage: "Upstash Redis" });
});

module.exports = app;