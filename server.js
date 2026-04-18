const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logger simple
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Routes
const bankRoutes = require("./src/routes/bankRoutes");
app.use("/api/bank", bankRoutes);

// Route de test
app.get("/", (req, res) => {
    res.json({
        name: "Bank API",
        version: "1.0.0",
        status: "running",
        endpoints: {
            GET: ["/api/bank/:userId", "/api/bank/top", "/api/bank/:userId/transactions"],
            POST: ["/api/bank/:userId/deposit", "/api/bank/:userId/withdraw", "/api/bank/:userId/card", "/api/bank/:userId/interest", "/api/bank/:userId/lottery", "/api/bank/:userId/parrain/create", "/api/bank/:userId/parrain/use"]
        }
    });
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({ success: false, error: "Route non trouvée" });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
    console.log(`Bank API demarree sur http://localhost:${PORT}`);
});