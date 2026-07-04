require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const DB_PATH = path.join(__dirname, "db.json");

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors());
// Raw body needed for webhook signature verification — must come before express.json()
app.use("/webhook/sumup", express.raw({ type: "application/json" }));
app.use(express.json());

/* ---------------- SIMPLE DB ---------------- */
const db = {
  data: { orders: [] },
  load() {
    if (fs.existsSync(DB_PATH)) {
      try {
        this.data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
      } catch {
        console.error("Failed to parse db.json — starting with empty orders");
        this.data = { orders: [] };
      }
    }
  },
  save() {
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, DB_PATH); // atomic write — avoids corruption on crash
  }
};
db.load();

/* ---------------- EMAIL (created once) ---------------- */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASS
  }
});

async function sendConfirmationEmail(order) {
  await transporter.sendMail({
    from: "SutreHouse <no-reply@sutrehouse.com>",
    to: order.email,
    subject: "Payment Confirmed",
    text: `Your order ${order.id} has been paid successfully.`
  });
}

/* ---------------- INPUT VALIDATION ---------------- */
function validateCheckoutInput(amount, email) {
  const errors = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Valid email is required");
  }
  if (amount === undefined || amount === null) {
    errors.push("Amount is required");
  } else if (typeof amount !== "number" || isNaN(amount) || amount <= 0) {
    errors.push("Amount must be a positive number");
  }
  return errors;
}

/* ---------------- WEBHOOK SIGNATURE VERIFICATION ---------------- */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.SUMUP_WEBHOOK_SECRET) return true; // skip in dev if not set
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", process.env.SUMUP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  // SumUp may prefix the signature with "sha256=" — handle both
  const incoming = signatureHeader.replace(/^sha256=/, "");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(incoming, "hex")
  );
}

/* ---------------- CREATE CHECKOUT ---------------- */
app.post("/create-checkout", async (req, res) => {
  try {
    const { amount, email } = req.body;

    const errors = validateCheckoutInput(amount, email);
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; ") });
    }

    const orderId = uuidv4();
    const order = {
      id: orderId,
      email,
      amount,
      status: "PENDING",
      createdAt: Date.now()
    };

    db.data.orders.push(order);
    db.save();

    const response = await axios.post(
      "https://api.sumup.com/v0.1/checkouts",
      {
        checkout_reference: orderId,
        amount,
        currency: "GBP",
        description: "SutreHouse Order",
        hosted_checkout: { enabled: true }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SUMUP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    const checkoutUrl = response.data.hosted_checkout_url;
    if (!checkoutUrl) {
      console.error("SumUp did not return a hosted_checkout_url", response.data);
      return res.status(502).json({ error: "Payment provider did not return a checkout URL" });
    }

    return res.json({
      checkoutId: response.data.id,
      checkoutUrl
    });
  } catch (err) {
    console.error("Checkout error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Checkout creation failed" });
  }
});

/* ---------------- WEBHOOK ---------------- */
app.post("/webhook/sumup", async (req, res) => {
  try {
    // Verify signature
    const signature = req.headers["x-payload-signature"];
    if (!verifyWebhookSignature(req.body, signature)) {
      console.warn("Webhook signature mismatch — rejected");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());

    if (event?.event_type !== "checkout.status_changed") {
      return res.sendStatus(200);
    }

    const checkout = event.payload;
    const orderId = checkout.checkout_reference;
    const status = checkout.status;

    const order = db.data.orders.find(o => o.id === orderId);
    if (!order) return res.sendStatus(200);
    if (order.status === "PAID") return res.sendStatus(200); // idempotency guard

    if (status === "PAID") {
      order.status = "PAID";
      order.paidAt = new Date().toISOString();
      db.save();

      // Email failure must not cause webhook to return 500 (would trigger retries)
      try {
        await sendConfirmationEmail(order);
      } catch (emailErr) {
        console.error(`Failed to send confirmation email for order ${order.id}:`, emailErr.message);
        // TODO: push to a retry queue or dead-letter log
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
});

/* ---------------- HEALTH ---------------- */
app.get("/", (req, res) => {
  res.send("Server running");
});

/* ---------------- START ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});