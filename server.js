const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const fs = require('fs');

dotenv.config();

// ─── Firebase Admin Init ───────────────────────────────────────────────────────
// Production: use FIREBASE_SERVICE_ACCOUNT env variable (JSON string)
// Local dev:  use serviceAccountKey.json file
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else if (fs.existsSync('./serviceAccountKey.json')) {
  serviceAccount = require('./serviceAccountKey.json');
} else {
  console.error('ERROR: No Firebase credentials found!');
  console.error('Set FIREBASE_SERVICE_ACCOUNT env variable or add serviceAccountKey.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const buildingsCol = db.collection('buildings');

// ─── Rate Limiter (in-memory, 1 req/min per userId) ───────────────────────────
const lastPostTime = {};

function rateLimiter(req, res, next) {
  const userId = req.body?.userId || req.headers['x-user-id'] || 'anonymous';
  const now = Date.now();
  const lastTime = lastPostTime[userId] || 0;

  if (now - lastTime < 60 * 1000) {
    const waitSec = Math.ceil((60 * 1000 - (now - lastTime)) / 1000);
    return res.status(429).json({
      error: `Rate limit exceeded. Try again in ${waitSec} seconds.`,
    });
  }

  lastPostTime[userId] = now;
  next();
}

// ─── Express App ───────────────────────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:4173',
      process.env.FRONTEND_URL || 'https://maxim-petriv.github.io',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-user-id'],
  })
);

app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/message', (req, res) => {
  res.json({ message: 'Hello from backend' });
});

// GET /api/buildings — fetch all buildings from Firestore
app.get('/api/buildings', async (req, res) => {
  try {
    const snapshot = await buildingsCol.get();
    const buildings = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(buildings);
  } catch (err) {
    console.error('GET /api/buildings error:', err);
    res.status(500).json({ error: 'Failed to fetch buildings' });
  }
});

// POST /api/buildings — create or upgrade a building
app.post('/api/buildings', rateLimiter, async (req, res) => {
  try {
    const { id, name, category, level, resources, userId } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    const data = {
      name: String(name),
      category: String(category),
      level: Number(level) || 1,
      resources: resources || {},
      userId: userId || 'anonymous',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    let docRef;
    if (id) {
      // Update existing building (upgrade)
      docRef = buildingsCol.doc(id);
      await docRef.update(data);
      res.json({ id, ...data, message: 'Building upgraded' });
    } else {
      // Create new building
      data.createdAt = admin.firestore.FieldValue.serverTimestamp();
      docRef = await buildingsCol.add(data);
      res.status(201).json({ id: docRef.id, ...data, message: 'Building created' });
    }
  } catch (err) {
    console.error('POST /api/buildings error:', err);
    res.status(500).json({ error: 'Failed to save building' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
