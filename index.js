const dns = require('node:dns');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

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
    // PAYMENT ROUTES (Stripe)
    // ════════════════════════════════════════════════════════════

    // Create payment intent
    app.post("/api/payments/create-intent", verifyJWT, async (req, res) => {
      const { hiringId } = req.body;
      const hiring = await hiringCollection.findOne({ _id: new ObjectId(hiringId) });
      if (!hiring) return res.status(404).json({ message: "Hiring not found" });
      if (hiring.paid) return res.status(400).json({ message: "Already paid" });

      const paymentIntent = await stripeInstance.paymentIntents.create({
        amount: hiring.fee * 100,
        currency: "usd",
        metadata: { hiringId: hiringId.toString(), userEmail: req.user.email },
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    });

    // Save payment after success
    app.post("/api/payments/confirm", verifyJWT, async (req, res) => {
      const { hiringId, transactionId, amount, lawyerEmail } = req.body;
      const payment = {
        transactionId,
        userEmail: req.user.email,
        lawyerEmail,
        amount: Number(amount),
        hiringId,
        date: new Date(),
      };
      const result = await paymentsCollection.insertOne(payment);
      await hiringCollection.updateOne(
        { _id: new ObjectId(hiringId) },
        { $set: { paid: true, transactionId } }
      );
      res.json(result);
    });

    // Admin: get all transactions
    app.get("/api/payments", verifyJWT, verifyAdmin, async (req, res) => {
      const payments = await paymentsCollection.find().sort({ date: -1 }).toArray();
      res.json(payments);
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