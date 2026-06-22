const dns = require('node:dns');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const jwt = require("jsonwebtoken");
const stripe = require("stripe");
dotenv.config();
console.log("Stripe key prefix:", process.env.STRIPE_SECRET_KEY?.slice(0, 12));


const app = express();
const PORT = process.env.PORT || 5000;
const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({
  credentials: true,
  origin: [process.env.CLIENT_URL],
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ─── JWT Middleware ───────────────────────────────────────────
const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ message: "Forbidden" });
  }
};

async function run() {
  try {
    await client.connect();
    console.log("Pinged your deployment. You successfully connected to MongoDB!");

    const db = client.db("legalease");
    const usersCollection = db.collection("users");
    const lawyersCollection = db.collection("lawyers");
    const hiringCollection = db.collection("hiringRequests");
    const paymentsCollection = db.collection("payments");
    const commentsCollection = db.collection("comments");

    // ─── Role Middleware ──────────────────────────────────────
    const verifyAdmin = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "admin") return res.status(403).json({ message: "Forbidden" });
      next();
    };

    const verifyLawyer = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "lawyer") return res.status(403).json({ message: "Forbidden" });
      next();
    };

    // ════════════════════════════════════════════════════════════
    // AUTH ROUTES
    // ════════════════════════════════════════════════════════════

    // Generate JWT
    app.post("/api/auth/jwt", async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).json({ message: "Email required" });
      const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.json({ token });
    });

     // Admin: get ALL lawyers (published + unpublished)
app.get("/api/lawyers/all", verifyJWT, verifyAdmin, async (req, res) => {
  const lawyers = await lawyersCollection.find().sort({ createdAt: -1 }).toArray();
  res.json(lawyers);
});

// ════════════════════════════════════════════════════════════
    // USERS ROUTES
    // ════════════════════════════════════════════════════════════

    // Save or update user on login/register
    app.post("/api/users", async (req, res) => {
      const { name, email, image, role } = req.body;
      const existing = await usersCollection.findOne({ email });
      if (existing) {
        return res.json({ message: "User already exists", user: existing });
      }
      const newUser = { name, email, image: image || "", role: role || "user", createdAt: new Date() };
      const result = await usersCollection.insertOne(newUser);
      res.json({ insertedId: result.insertedId, user: newUser });
    });

    / Get current user info
    app.get("/api/users/me", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    });

    // Update profile (name + image)
    // এই route টা update করো:
app.patch("/api/users/me", verifyJWT, async (req, res) => {
  const { name, image, phone, address, city, country, bio } = req.body;
  const result = await usersCollection.updateOne(
    { email: req.user.email },
    { $set: { name, image, phone, address, city, country, bio } }
  );
  res.json(result);
});



    // Get latest 6 lawyers for home page
    app.get("/api/lawyers/featured", async (req, res) => {
      const lawyers = await lawyersCollection.find({ published: true }).sort({ createdAt: -1 }).limit(6).toArray();
      res.json(lawyers);
    });


     
   

    
    

   

    

    
    // User sends hiring request
    app.post("/api/hiring", verifyJWT, async (req, res) => {
      const { lawyerId, lawyerEmail, lawyerName, fee } = req.body;
      const existing = await hiringCollection.findOne({
        userEmail: req.user.email,
        lawyerId,
        status: { $in: ["pending", "accepted"] },
      });
      if (existing) return res.status(400).json({ message: "Already hired or request pending" });

      const request = {
        userEmail: req.user.email,
        lawyerId,
        lawyerEmail,
        lawyerName,
        fee: Number(fee),
        status: "pending",
        paid: false,
        requestDate: new Date(),
      };
      const result = await hiringCollection.insertOne(request);
      res.json(result);
    });

    // User: get their hiring history
    app.get("/api/hiring/my", verifyJWT, async (req, res) => {
      const requests = await hiringCollection.find({ userEmail: req.user.email }).sort({ requestDate: -1 }).toArray();
      res.json(requests);
    });

    // Lawyer: get hiring requests for them
    app.get("/api/hiring/lawyer", verifyJWT, async (req, res) => {
      const requests = await hiringCollection.find({ lawyerEmail: req.user.email }).sort({ requestDate: -1 }).toArray();
      res.json(requests);
    });

  
   

    // ════════════════════════════════════════════════════════════
    // ADMIN ANALYTICS
    // ════════════════════════════════════════════════════════════

    app.get("/api/admin/analytics", verifyJWT, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments({ role: "user" });
      const totalLawyers = await usersCollection.countDocuments({ role: "lawyer" });
      const totalHires = await hiringCollection.countDocuments();
      const revenueResult = await paymentsCollection.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).toArray();
      const totalRevenue = revenueResult[0]?.total || 0;
      res.json({ totalUsers, totalLawyers, totalHires, totalRevenue });
    });

    // ════════════════════════════════════════════════════════════
    // ROOT
    // ════════════════════════════════════════════════════════════
    app.get("/", (req, res) => res.send("LegalEase Server Running"));

  } finally {
    // keep connection open
  }
}

run().catch(console.dir);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));