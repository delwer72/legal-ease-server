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


// ── Admin: Get all users ──
    app.get("/api/users", verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.json(users);
    });

    // ── Admin: Change user role ──
    app.patch("/api/users/:id/role", verifyJWT, verifyAdmin, async (req, res) => {
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );
      res.json(result);
    });

    // ── Admin: Delete user ──
    app.delete("/api/users/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });


    // ════════════════════════════════════════════════════════════
    // LAWYERS ROUTES
    // ════════════════════════════════════════════════════════════

    // Get all published lawyers (public) with search, filter, sort, pagination
    app.get("/api/lawyers", async (req, res) => {
      const { search, specialization, minFee, maxFee, availability, sort, page = 1, limit = 9 } = req.query;
      const query = { published: true };

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { specialization: { $regex: search, $options: "i" } },
        ];
      }
      if (specialization) query.specialization = { $regex: specialization, $options: "i" };
      if (availability) query.status = availability;
      if (minFee || maxFee) {
        query.fee = {};
        if (minFee) query.fee.$gte = Number(minFee);
        if (maxFee) query.fee.$lte = Number(maxFee);
      }

      const sortOption = sort === "fee_asc" ? { fee: 1 } : sort === "fee_desc" ? { fee: -1 } : { createdAt: -1 };
      const skip = (Number(page) - 1) * Number(limit);
      const total = await lawyersCollection.countDocuments(query);
      const lawyers = await lawyersCollection.find(query).sort(sortOption).skip(skip).limit(Number(limit)).toArray();
      res.json({ lawyers, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
    });



    // Get latest 6 lawyers for home page
    app.get("/api/lawyers/featured", async (req, res) => {
      const lawyers = await lawyersCollection.find({ published: true }).sort({ createdAt: -1 }).limit(6).toArray();
      res.json(lawyers);
    });


    // Get top 3 most hired lawyers
    app.get("/api/lawyers/top", async (req, res) => {
      const lawyers = await lawyersCollection.find({ published: true }).sort({ totalHires: -1 }).limit(3).toArray();
      res.json(lawyers);
    });

    // Get single lawyer by ID (public)
    app.get("/api/lawyers/:id", async (req, res) => {
      const lawyer = await lawyersCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!lawyer) return res.status(404).json({ message: "Lawyer not found" });
      res.json(lawyer);
    });


    // Lawyer creates their profile
    app.post("/api/lawyers", verifyJWT, async (req, res) => {
      const { name, bio, specialization, fee, image } = req.body;
      const existing = await lawyersCollection.findOne({ lawyerEmail: req.user.email });
      if (existing) return res.status(400).json({ message: "Profile already exists" });
      const newLawyer = {
        lawyerEmail: req.user.email,
        name, bio, specialization,
        fee: Number(fee),
        image,
        status: "Available",
        published: false,
        totalHires: 0,
        createdAt: new Date(),
      };
      const result = await lawyersCollection.insertOne(newLawyer);
      res.json(result);
    });


    // Lawyer updates their profile
    app.patch("/api/lawyers/my-profile", verifyJWT, async (req, res) => {
  const {
    name, bio, specialization, fee, image,
    phone, city, country, experience, education,
    languages, availability, linkedin, twitter,
    consultationTime, achievements,
  } = req.body;

  const result = await lawyersCollection.updateOne(
    { lawyerEmail: req.user.email },
    {
      $set: {
        name, bio, specialization, fee: Number(fee), image,
        phone, city, country, experience, education,
        languages, availability, linkedin, twitter,
        consultationTime, achievements,
        status: availability || "Available",
      },
    }
  );
  res.json(result);
});

// Get lawyer's own profile
    app.get("/api/lawyers/my-profile/me", verifyJWT, async (req, res) => {
      const lawyer = await lawyersCollection.findOne({ lawyerEmail: req.user.email });
      res.json(lawyer);
    });

    // Lawyer publish/unpublish their profile
    app.patch("/api/lawyers/my-profile/publish", verifyJWT, async (req, res) => {
      const { published } = req.body;
      const result = await lawyersCollection.updateOne(
        { lawyerEmail: req.user.email },
        { $set: { published } }
      );
      res.json(result);
    });

    // ── Admin: publish/unpublish/delete any lawyer ──
    app.patch("/api/lawyers/:id/publish", verifyJWT, verifyAdmin, async (req, res) => {
      const { published } = req.body;
      const result = await lawyersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { published } }
      );
      res.json(result);
    });

    app.delete("/api/lawyers/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await lawyersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
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


    // Lawyer: accept or reject hiring request
    app.patch("/api/hiring/:id/status", verifyJWT, async (req, res) => {
      const { status } = req.body; // "accepted" or "rejected"
      const result = await hiringCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      if (status === "accepted") {
        const hiring = await hiringCollection.findOne({ _id: new ObjectId(req.params.id) });
        await lawyersCollection.updateOne(
          { _id: new ObjectId(hiring.lawyerId) },
          { $inc: { totalHires: 1 } }
        );
      }
      res.json(result);
    });

    // Check if user has hired a lawyer (for comment permission)
    app.get("/api/hiring/check/:lawyerId", verifyJWT, async (req, res) => {
      const hiring = await hiringCollection.findOne({
        userEmail: req.user.email,
        lawyerId: req.params.lawyerId,
        status: "accepted",
      });
      res.json({ hasHired: !!hiring });
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
    // COMMENTS ROUTES
    // ════════════════════════════════════════════════════════════

    // Get comments for a lawyer
    app.get("/api/comments/:lawyerId", async (req, res) => {
      const comments = await commentsCollection.find({ lawyerId: req.params.lawyerId }).sort({ createdAt: -1 }).toArray();
      res.json(comments);
    });

    // Post a comment (only if hired)
    app.post("/api/comments", verifyJWT, async (req, res) => {
      const { lawyerId, comment } = req.body;
      const hiring = await hiringCollection.findOne({
        userEmail: req.user.email,
        lawyerId,
        status: "accepted",
      });
      if (!hiring) return res.status(403).json({ message: "You must hire this lawyer first" });

      const user = await usersCollection.findOne({ email: req.user.email });
      const newComment = {
        lawyerId,
        userEmail: req.user.email,
        userName: user?.name || "Anonymous",
        userImage: user?.image || "",
        comment,
        createdAt: new Date(),
      };
      const result = await commentsCollection.insertOne(newComment);
      res.json(result);
    });

    // User: get their own comments
    app.get("/api/comments/user/my", verifyJWT, async (req, res) => {
      const comments = await commentsCollection.find({ userEmail: req.user.email }).sort({ createdAt: -1 }).toArray();
      res.json(comments);
    });

    // User: edit comment
    app.patch("/api/comments/:id", verifyJWT, async (req, res) => {
      const { comment } = req.body;
      const result = await commentsCollection.updateOne(
        { _id: new ObjectId(req.params.id), userEmail: req.user.email },
        { $set: { comment } }
      );
      res.json(result);
    });

    // User: delete comment
    app.delete("/api/comments/:id", verifyJWT, async (req, res) => {
      const result = await commentsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        userEmail: req.user.email,
      });
      res.json(result);
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