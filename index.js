const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BANK_PATH = path.resolve(__dirname, "bank.json");

app.use(express.json());

// Lecture du fichier banque
function readBank() {
  if (!fs.existsSync(BANK_PATH)) fs.writeFileSync(BANK_PATH, "{}");
  return JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
}

// Écriture du fichier banque
function writeBank(data) {
  fs.writeFileSync(BANK_PATH, JSON.stringify(data, null, 2));
}

// Route d'accueil
app.get("/", (req, res) => {
  res.json({ message: "BANK API is online!" });
});

// Obtenir le solde
app.get("/bank/:uid/balance", (req, res) => {
  const uid = req.params.uid;
  const bankData = readBank();
  if (!bankData[uid]) return res.status(404).json({ error: "Compte bancaire non trouvé." });
  res.json({ uid, bank: bankData[uid].bank || 0 });
});

// Créer un compte ou déposer
app.post("/bank/save", (req, res) => {
  const { uid, amount } = req.body;
  if (!uid || !amount) return res.status(400).json({ error: "uid et amount requis." });

  const bankData = readBank();
  if (!bankData[uid]) bankData[uid] = { bank: 0 };
  bankData[uid].bank += Number(amount);
  writeBank(bankData);
  res.json({ success: true, bank: bankData[uid].bank });
});

// Retirer
app.post("/bank/withdraw", (req, res) => {
  const { uid, amount } = req.body;
  if (!uid || !amount) return res.status(400).json({ error: "uid et amount requis." });

  const bankData = readBank();
  if (!bankData[uid]) return res.status(404).json({ error: "Compte bancaire non trouvé." });
  if (amount > bankData[uid].bank) return res.status(400).json({ error: "Fonds insuffisants." });
  bankData[uid].bank -= Number(amount);
  writeBank(bankData);
  res.json({ success: true, bank: bankData[uid].bank });
});

// Transférer
app.post("/bank/transfer", (req, res) => {
  const { fromUid, toUid, amount } = req.body;
  if (!fromUid || !toUid || !amount) return res.status(400).json({ error: "fromUid, toUid, amount requis." });

  const bankData = readBank();
  if (!bankData[fromUid]) return res.status(404).json({ error: "Expéditeur inconnu." });
  if (amount > bankData[fromUid].bank) return res.status(400).json({ error: "Fonds insuffisants." });

  if (!bankData[toUid]) bankData[toUid] = { bank: 0 };
  bankData[fromUid].bank -= Number(amount);
  bankData[toUid].bank += Number(amount);
  writeBank(bankData);
  res.json({ success: true, fromBank: bankData[fromUid].bank, toBank: bankData[toUid].bank });
});

// Voir le top des riches
app.get("/bank/top", (req, res) => {
  const bankData = readBank();
  const topUsers = Object.entries(bankData)
    .sort(([, a], [, b]) => (b.bank || 0) - (a.bank || 0))
    .slice(0, 10)
    .map(([uid, data], i) => ({ rank: i + 1, uid, bank: data.bank }));
  res.json({ top: topUsers });
});

// Lancer le serveur
app.listen(PORT, () => {
  console.log(`BANK API en ligne sur http://localhost:${PORT}`);
});
